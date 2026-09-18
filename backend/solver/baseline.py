"""
Baseline greedy scheduler — the default `solve_scenario()` implementation.

It is deliberately readable rather than clever: priority-ordered, earliest
feasible week, aggressive co-share packing. It exists so the app is fully
interactive from day one and so a team member can swap in a real optimiser
(CP-SAT, LNS, column generation...) by registering a new callable in
`solver/registry.py` without touching the API or the UI.

Hard rules enforced here
------------------------
1. Workload conservation  every activity scheduled to >= total_accesses units
2. Planned start date     no access before the planned start week
3. Predecessor (FS+0)     successor's first week strictly after predecessor's last
4. Closures & buffers     exclusion ring (incl. 750V mirror + H01_H02 crossover)
5. Legal mixes            per slot: one PM alone | one PC + <=3 C | <=4 C
6. Co-sharing exemption   same (location, week, co_share_group) == one possession
7. Weekly allocation      <= number_of_maximum_access_per_week distinct nights
8. Workfronts             <= number_of_workfronts activities per access_night
9. ECLO                   1.5 units/night
10. ECLO continuity        Scenario C: <= 2-week window per line; A: forbidden

Modelling notes (documented simplifications, see README)
--------------------------------------------------------
* `supply_capacity` at a location-week is read as the number of possession
  slots (nights) available there that week; `co_share_group` labels the slot.
* Buffer conflicts are evaluated at week granularity between the strict
  exclusion ring (buffer zone minus own worked path) of one activity and the
  worked path of another. This is conservative: it never produces a breach,
  it can only cost a little packing density.
"""

from __future__ import annotations

import math
from collections import defaultdict
from typing import Dict, List, Optional, Set, Tuple

from .network import (
    ActivityPlan,
    Calendar,
    Network,
    build_activity_plans,
    parse_location,
    topological_order,
)
from .schemas import (
    AccessRow,
    InstanceData,
    OccupancyRow,
    SoftScores,
    SolveOutput,
    Violation,
)
from .scoring import build_results, compute_soft_scores

MAX_OVERRUN_WEEKS = 78          # how far past the horizon we may push work
EXCESS_ALLOWANCE = {"A": 0, "B": 10_000, "C": 1}
ECLO_ALLOWED = {"A": False, "B": True, "C": True}
ECLO_YIELD = 1.5
ECLO_WINDOW_WEEKS = 2           # Scenario C continuity window, per line


class _Slot:
    __slots__ = ("label", "pm", "pc", "c", "activities")

    def __init__(self, label: str):
        self.label = label
        self.pm = 0
        self.pc = 0
        self.c = 0
        self.activities: List[str] = []

    def accepts(self, access_type: str) -> bool:
        if self.pm:
            return False
        if access_type == "PM":
            return not self.activities
        if access_type == "PC":
            return self.pc == 0 and self.c <= 3
        return (self.pc == 1 and self.c < 3) or (self.pc == 0 and self.c < 4)

    def add(self, access_type: str, activity_id: str) -> None:
        if access_type == "PM":
            self.pm = 1
        elif access_type == "PC":
            self.pc += 1
        else:
            self.c += 1
        self.activities.append(activity_id)


class _State:
    """Mutable booking ledger shared across one solve."""

    def __init__(self, net: Network, scenario: str):
        self.net = net
        self.scenario = scenario
        self.excess_allowance = EXCESS_ALLOWANCE.get(scenario, 0)
        # (location_id, week) -> [slots]
        self.slots: Dict[Tuple[str, int], List[_Slot]] = defaultdict(list)
        # (contract, activity_type, week) -> {night: [activity_id]}
        self.nights: Dict[Tuple[str, str, int], Dict[int, List[str]]] = defaultdict(dict)
        # week -> [(activity_id, path set, strict exclusion ring)]
        self.week_footprints: Dict[int, List[Tuple[str, Set[str], Set[str]]]] = defaultdict(list)
        # line -> first ECLO week (Scenario C continuity window anchor)
        self.eclo_window: Dict[str, int] = {}

    # -- weekly allocation + workfronts (rules 7 & 8) ---------------------- #

    def find_night(
        self, contract: str, activity_type: str, week: int, cap: int, workfronts: int
    ) -> Optional[int]:
        book = self.nights[(contract, activity_type, week)]
        for night in range(1, cap + 1):
            if len(book.get(night, [])) < workfronts:
                return night
        return None

    def book_night(
        self, contract: str, activity_type: str, week: int, night: int, activity_id: str
    ) -> None:
        self.nights[(contract, activity_type, week)].setdefault(night, []).append(activity_id)

    # -- buffers (rule 4) --------------------------------------------------- #

    def buffer_clear(self, week: int, path: Set[str], ring: Set[str]) -> bool:
        for _aid, other_path, other_ring in self.week_footprints[week]:
            if ring & other_path:
                return False
            if other_ring & path:
                return False
        return True

    # -- capacity + legal mixes (rules 5 & 6) ------------------------------- #

    def try_allocate(
        self, path: List[str], week: int, access_type: str, activity_id: str, commit: bool
    ) -> Optional[Dict[str, str]]:
        """Return {location_id: co_share_group} if the whole path can be booked."""
        chosen: Dict[str, str] = {}
        staged: List[Tuple[Tuple[str, int], _Slot, bool]] = []

        for loc in path:
            cap = self.net.capacity(loc, week)
            limit = cap + self.excess_allowance if self.net.capacity(loc) else 1 + self.excess_allowance
            key = (loc, week)
            existing = self.slots[key]

            slot = next((s for s in existing if s.accepts(access_type)), None)
            is_new = False
            if slot is None:
                if len(existing) >= limit:
                    return None
                slot = _Slot(f"b{len(existing) + 1}")
                is_new = True
            chosen[loc] = slot.label
            staged.append((key, slot, is_new))

        if commit:
            for key, slot, is_new in staged:
                if is_new:
                    self.slots[key].append(slot)
                slot.add(access_type, activity_id)
        return chosen


def _eclo_permitted(state: _State, scenario: str, week: int, lines: Set[str]) -> bool:
    if not ECLO_ALLOWED.get(scenario, False):
        return False
    if scenario != "C":
        return True
    # Scenario C: every ECLO night on a line must sit in one <= 2-week span.
    for line in lines:
        anchor = state.eclo_window.get(line)
        if anchor is not None and not (anchor <= week <= anchor + ECLO_WINDOW_WEEKS - 1):
            return False
    return True


def _commit_eclo_window(state: _State, scenario: str, week: int, lines: Set[str]) -> None:
    if scenario != "C":
        return
    for line in lines:
        state.eclo_window.setdefault(line, week)


def _run(
    scenario: str,
    data: InstanceData,
    rank: Optional[Dict[str, float]],
    aggressive_eclo: bool = False,
) -> SolveOutput:
    """One greedy pass over the activities in the order implied by `rank`."""
    cal = Calendar(data.parameters.horizon_start, data.parameters.horizon_weeks)
    net = Network.build(data)
    plans: Dict[str, ActivityPlan] = build_activity_plans(data, net, cal)
    contracts = data.contract_map()
    state = _State(net, scenario)

    access_rows: List[AccessRow] = []
    occupancy_rows: List[OccupancyRow] = []
    violations: List[Violation] = []
    last_week_by_activity: Dict[str, int] = {}

    horizon_cap = data.parameters.horizon_weeks + MAX_OVERRUN_WEEKS

    for activity_id in topological_order(data, rank):
        plan = plans[activity_id]
        act = plan.activity
        contract = contracts.get(act.contract_number)
        if contract is None:
            violations.append(
                Violation(
                    rule="workload",
                    detail=f"{activity_id}: contract {act.contract_number} not in 07_PROJECT_DETAILS.csv",
                )
            )
            continue

        access_type = (contract.access_type or "C").upper()
        cap = contract.number_of_maximum_access_per_week
        workfronts = contract.number_of_workfronts
        deadline_week = (
            cal.week_of(contract.planned_completion_date)
            if contract.planned_completion_date
            else horizon_cap
        )

        # rule 2 + rule 3
        week = plan.earliest_week
        pred = act.predecessor_activity_id
        if pred and pred in last_week_by_activity:
            week = max(week, last_week_by_activity[pred] + 1)

        path_set = set(plan.path)
        ring = set(plan.buffer_zone) - path_set

        remaining = plan.nights_required
        seq = 0
        while remaining > 1e-9 and week <= horizon_cap:
            night = state.find_night(act.contract_number, act.activity_type, week, cap, workfronts)
            if night is None:
                week += 1
                continue
            if not state.buffer_clear(week, path_set, ring):
                week += 1
                continue

            # ECLO only when the standard-night plan would overrun the target
            weeks_to_deadline = deadline_week - week + 1
            want_eclo = remaining > max(0, weeks_to_deadline)
            if aggressive_eclo and week <= deadline_week:
                # Scenario B escalation: dates are hard, so buy compression
                # wherever it can still land inside the deadline.
                want_eclo = True
            use_eclo = (
                want_eclo
                and remaining > 1.0
                and _eclo_permitted(state, scenario, week, plan.lines_touched)
            )

            allocation = state.try_allocate(plan.path, week, access_type, activity_id, commit=False)
            if allocation is None:
                week += 1
                continue

            state.try_allocate(plan.path, week, access_type, activity_id, commit=True)
            state.book_night(act.contract_number, act.activity_type, week, night, activity_id)
            state.week_footprints[week].append((activity_id, path_set, ring))
            if use_eclo:
                _commit_eclo_window(state, scenario, week, plan.lines_touched)

            seq += 1
            access_rows.append(
                AccessRow(
                    activity_id=activity_id,
                    access_seq=seq,
                    week=week,
                    eclo=1 if use_eclo else 0,
                    access_night=night,
                )
            )
            for loc, group in allocation.items():
                occupancy_rows.append(
                    OccupancyRow(
                        activity_id=activity_id, week=week, location_id=loc, co_share_group=group
                    )
                )

            remaining -= ECLO_YIELD if use_eclo else 1.0
            last_week_by_activity[activity_id] = week
            week += 1

        if remaining > 1e-9:
            violations.append(
                Violation(
                    rule="workload",
                    detail=(
                        f"{activity_id}: {remaining:.1f} of {plan.nights_required:.1f} access "
                        f"units unplaced within week {horizon_cap}"
                    ),
                )
            )

    # ---- scenario-specific hard gates ------------------------------------ #
    results = build_results(data, cal, access_rows, scenario)

    if scenario == "A":
        for r in access_rows:
            if r.eclo:
                violations.append(
                    Violation(rule="eclo", detail=f"{r.activity_id} wk{r.week}: ECLO forbidden in Scenario A")
                )
                break

    supply = data.supply_map()
    used: Dict[Tuple[str, int], Set[str]] = defaultdict(set)
    for row in occupancy_rows:
        used[(row.location_id, row.week)].add(row.co_share_group)
    allowance = EXCESS_ALLOWANCE.get(scenario, 0)
    if scenario != "B":
        for (loc, wk), groups in used.items():
            over = len(groups) - supply.get(loc, 0)
            if over > allowance:
                violations.append(
                    Violation(
                        rule="capacity",
                        detail=f"wk{wk}: {loc} uses {len(groups)} access-nights vs supply {supply.get(loc, 0)}",
                    )
                )

    if scenario == "B":
        for r in results:
            if r.overrun_days > 0:
                violations.append(
                    Violation(
                        rule="planned_date",
                        detail=(
                            f"{r.contract_number}: completes {r.simulated_completion_date}, "
                            f"{r.overrun_days}d past planned_completion_date (hard in Scenario B)"
                        ),
                    )
                )

    feasible = not violations
    scores, hotspots = compute_soft_scores(
        data, cal, scenario, access_rows, occupancy_rows, results, feasible
    )

    return SolveOutput(
        scenario=scenario,
        feasible=feasible,
        hard_violations=violations[:200],
        soft_scores=scores,
        detail={
            "capacity_hotspots": hotspots,
            "nights_scheduled": len(access_rows),
            "eclo_nights": scores.eclo_nights_total,
            "activities_scheduled": len(last_week_by_activity),
            "activities_total": len(data.activities),
            "solver": "greedy-baseline",
        },
        schedule_access=access_rows,
        schedule_occupancy=occupancy_rows,
        results=results,
    )


# --------------------------------------------------------------------------- #
# multi-start + adaptive reordering                                            #
# --------------------------------------------------------------------------- #


def _seed_ranks(data: InstanceData, cal: Calendar) -> List[Dict[str, float]]:
    """A handful of structurally different dispatch orders to start from."""
    contracts = data.contract_map()
    weight = {1: 100.0, 2: 10.0, 3: 1.0}

    by_tier: Dict[str, float] = {}
    by_slack: Dict[str, float] = {}
    by_start: Dict[str, float] = {}
    by_criticality: Dict[str, float] = {}

    for a in data.activities:
        c = contracts.get(a.contract_number)
        tier = c.contract_priority if c else 3
        start_wk = cal.week_of(a.planned_start_date)
        deadline_wk = cal.week_of(c.planned_completion_date) if c and c.planned_completion_date else 999
        slack = deadline_wk - start_wk - a.total_accesses + 1

        by_tier[a.activity_id] = tier * 1000 + a.activity_priority * 100 + start_wk
        by_slack[a.activity_id] = slack * 10 + a.activity_priority
        by_start[a.activity_id] = start_wk * 10 + tier
        by_criticality[a.activity_id] = -(weight.get(tier, 1.0) * a.total_accesses) + slack

    return [by_tier, by_slack, by_start, by_criticality]


def _quality(out: SolveOutput) -> tuple:
    """Lower is better: feasibility first, then the scenario objective."""
    obj = out.soft_scores.objective_score
    if obj is None:
        obj = (
            out.soft_scores.priority_weighted_score
            + 7.0 * out.soft_scores.excess_access_nights_total
            + 5.0 * out.soft_scores.eclo_nights_total
        )
    return (len(out.hard_violations), obj, out.soft_scores.overrun_days_total)


def _reorder_from(out: SolveOutput, data: InstanceData, cal: Calendar, base: Dict[str, float]) -> Dict[str, float]:
    """Promote whatever overran in `out` to the front of the next pass."""
    contracts = data.contract_map()
    acts = data.activity_map()
    weight = {1: 100.0, 2: 10.0, 3: 1.0}
    nudge = {1: 0.3, 2: 0.2, 3: 0.0}

    last: Dict[str, int] = {}
    for r in out.schedule_access:
        last[r.activity_id] = max(last.get(r.activity_id, 0), r.week)

    penalty: Dict[str, float] = {}
    for aid, wk in last.items():
        a = acts.get(aid)
        c = contracts.get(a.contract_number) if a else None
        if not a or not c or not c.planned_completion_date:
            continue
        days = max(0, (cal.sunday_of(wk) - c.planned_completion_date).days)
        if days:
            penalty[aid] = weight.get(c.contract_priority, 1.0) * (1 + nudge.get(a.activity_priority, 0.0)) * days

    if not penalty:
        return base
    span = max(base.values()) - min(base.values()) or 1.0
    return {
        aid: base.get(aid, 0.0) - (penalty.get(aid, 0.0) / (max(penalty.values()) or 1.0)) * span * 1.2
        for aid in base
    }


def solve_baseline(scenario: str, data: InstanceData, iterations: int = 14) -> SolveOutput:
    """
    Multi-start greedy: try several dispatch orders, then iteratively promote
    whatever overran on the best pass and re-run. Deterministic, and fast
    enough (tens of ms per pass on the reference instance) to stay interactive.
    """
    scenario = scenario.upper()
    cal = Calendar(data.parameters.horizon_start, data.parameters.horizon_weeks)

    best: Optional[SolveOutput] = None
    best_rank: Optional[Dict[str, float]] = None

    aggressive = False
    for rank in [None] + _seed_ranks(data, cal):
        out = _run(scenario, data, rank)
        if best is None or _quality(out) < _quality(best):
            best, best_rank = out, rank

    seen: set = set()
    rank = best_rank if best_rank is not None else _seed_ranks(data, cal)[0]
    for _ in range(iterations):
        rank = _reorder_from(best, data, cal, rank)
        signature = tuple(sorted(rank.items()))
        if signature in seen:
            break
        seen.add(signature)
        out = _run(scenario, data, rank, aggressive)
        if _quality(out) < _quality(best):
            best = out
        if not best.hard_violations and best.soft_scores.priority_weighted_score == 0:
            break

    # Scenario B treats planned_completion_date as hard. If a plain pass still
    # overruns, escalate: spend ECLO aggressively (soft-scored at 5x) rather
    # than fail the date gate, and keep whichever pass ends up better.
    if scenario == "B" and best.hard_violations:
        rank_b = best_rank if best_rank is not None else _seed_ranks(data, cal)[0]
        escalated = _run(scenario, data, rank_b, True)
        if _quality(escalated) < _quality(best):
            best = escalated
        for _ in range(iterations):
            rank_b = _reorder_from(best, data, cal, rank_b)
            out = _run(scenario, data, rank_b, True)
            if _quality(out) < _quality(best):
                best = out
            if not best.hard_violations:
                break

    assert best is not None
    best.detail["solver"] = "greedy-baseline (multi-start + adaptive reorder)"
    return best
