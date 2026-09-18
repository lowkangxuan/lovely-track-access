"""Time-indexed CP-SAT scheduling with a complete-workload greedy incumbent.

Placements are (week, possession night, ECLO). Possession labels are consistent
across locations; exported access_night values are local contract/type indices.
No cap on schedule slip is imposed on the constructive fallback. CP-SAT refines
its finite horizon and night palette, and reports its bounded search status.
"""
from collections import defaultdict
from itertools import combinations
import math
import os

from ortools.sat.python import cp_model

from .network import Calendar, Network, build_activity_plans, topological_order
from .schemas import AccessRow, OccupancyRow, SolveOutput, SoftScores
from .scoring import build_results, compute_soft_scores
from .validation import validate_schedule


def can_share(a, b, plans, contracts):
    """The exemption needs a common worked location and a legal possession mix."""
    ta = contracts[plans[a].activity.contract_number].access_type
    tb = contracts[plans[b].activity.contract_number].access_type
    return ("PM" not in (ta, tb) and (ta, tb) != ("PC", "PC")
            and bool(set(plans[a].path) & set(plans[b].path)))


def conflict_pairs(plans, contracts):
    pairs = []
    for a, b in combinations(plans, 2):
        pa, pb = plans[a], plans[b]
        if set(pa.buffer_zone) & set(pb.buffer_zone) and not can_share(a, b, plans, contracts):
            pairs.append((a, b))
    return pairs


def _greedy(data, policy, plans, net, cal, mode):
    """Always finish schedulable workload, extending the calendar under congestion."""
    contracts = data.contract_map()
    rank = {}
    for aid, p in plans.items():
        c = contracts[p.activity.contract_number]
        due = cal.week_of(c.planned_completion_date)
        rank[aid] = ((due - p.nights_required - p.earliest_week) if mode == 0
                     else c.contract_priority * 1000 + p.earliest_week if mode == 1
                     else due * 100 + p.earliest_week)
    conflicts = {frozenset(pair) for pair in conflict_pairs(plans, contracts)}
    placed, bookings, windows = {}, defaultdict(list), {}
    location_slots = defaultdict(set)
    contract_slots = defaultdict(lambda: defaultdict(list))
    blocked = []
    for aid in topological_order(data, rank):
        p, a = plans[aid], plans[aid].activity
        c = contracts[a.contract_number]
        if a.predecessor_activity_id in blocked:
            blocked.append(aid)
            continue
        if policy.excess == 0 and any(net.capacity(loc) == 0 for loc in p.path):
            blocked.append(aid)
            continue
        week = p.earliest_week
        if a.predecessor_activity_id:
            week = max(week, placed[a.predecessor_activity_id][-1][0] + 1)
        remaining, rows = a.total_accesses, []
        while remaining > 1e-9:
            # At most one new night per activity is ever necessary in a week.
            occupied_slots = [s for (w, s) in bookings if w == week]
            selected = None
            for slot in range(1, max(occupied_slots, default=0) + 2):
                others = bookings[week, slot]
                if any(frozenset((aid, b)) in conflicts for b in others):
                    continue
                book = contract_slots[a.contract_number, a.activity_type, week]
                if len(book.get(slot, [])) >= c.number_of_workfronts:
                    continue
                if slot not in book and len(book) >= c.number_of_maximum_access_per_week:
                    continue
                valid = True
                for loc in p.path:
                    existing = [b for b in others if loc in plans[b].path]
                    types = [contracts[plans[b].activity.contract_number].access_type for b in existing] + [c.access_type]
                    if len(types) > 4 or types.count("PC") > 1 or ("PM" in types and len(types) > 1):
                        valid = False
                        break
                    used = location_slots[loc, week]
                    if (policy.excess is not None and slot not in used
                            and len(used) >= net.capacity(loc, week) + policy.excess):
                        valid = False
                        break
                if valid:
                    selected = slot
                    break
            if selected is None:
                week += 1
                continue
            due = (c.planned_completion_date - cal.start).days // 7 + 1
            want = policy.eclo and remaining > 1 and (mode == 2 or remaining > due - week + 1)
            if policy.continuity:
                want = want and all(line not in windows or max(week, windows[line][1]) - min(week, windows[line][0]) <= 1
                                    for line in p.lines_touched)
            if want:
                for line in p.lines_touched:
                    lo, hi = windows.get(line, (week, week))
                    windows[line] = (min(lo, week), max(hi, week))
            rows.append((week, selected, int(want)))
            bookings[week, selected].append(aid)
            contract_slots[a.contract_number, a.activity_type, week][selected].append(aid)
            for loc in p.path:
                location_slots[loc, week].add(selected)
            remaining -= 1.5 if want else 1
            week += 1
        placed[aid] = rows
    return placed


def _output(data, policy, placements, detail=None):
    cal = Calendar(data.parameters.horizon_start, data.parameters.horizon_weeks)
    plans = build_activity_plans(data, Network.build(data), cal)
    local = defaultdict(set)
    for aid, rows in placements.items():
        a = plans[aid].activity
        for w, slot, _ in rows:
            local[a.contract_number, a.activity_type, w].add(slot)
    access, occupancy = [], []
    for aid, rows in sorted(placements.items()):
        a = plans[aid].activity
        for seq, (week, slot, eclo) in enumerate(sorted(rows), 1):
            night = sorted(local[a.contract_number, a.activity_type, week]).index(slot) + 1
            access.append(AccessRow(activity_id=aid, access_seq=seq, week=week, eclo=eclo, access_night=night))
            occupancy.extend(OccupancyRow(activity_id=aid, week=week, location_id=loc,
                                          co_share_group=f"night-{slot}") for loc in plans[aid].path)
    out = SolveOutput(scenario=policy.scenario, soft_scores=SoftScores(scenario=policy.scenario),
                      schedule_access=access, schedule_occupancy=occupancy,
                      results=build_results(data, cal, access, policy.scenario))
    out.hard_violations = validate_schedule(data, out)
    out.feasible = not out.hard_violations
    out.soft_scores, hotspots = compute_soft_scores(data, cal, policy.scenario, access, occupancy, out.results, out.feasible)
    out.detail = {"solver": f"scenario-{policy.scenario.lower()}-cp-sat",
                  "capacity_hotspots": hotspots, "nights_scheduled": len(access),
                  "eclo_nights": out.soft_scores.eclo_nights_total,
                  "activities_scheduled": len(placements), "activities_total": len(data.activities),
                  "validation": "internal; official validator not supplied", **(detail or {})}
    return out


def _quality(out):
    s = out.soft_scores
    return (len(out.hard_violations), s.objective_score if s.objective_score is not None
            else s.priority_weighted_score + 7 * s.excess_access_nights_total + 5 * s.eclo_nights_total)


def optimize(data, policy):
    cal = Calendar(data.parameters.horizon_start, data.parameters.horizon_weeks)
    net = Network.build(data)
    plans = build_activity_plans(data, net, cal)
    contracts = data.contract_map()
    seeds = [_greedy(data, policy, plans, net, cal, mode) for mode in range(3)]
    if policy.scenario == "C":
        from .policies import STRICT_SUPPLY
        # Include strict-supply plans so elasticity never forces extra spending.
        seeds.extend(_greedy(data, STRICT_SUPPLY, plans, net, cal, mode) for mode in range(3))
    seed = min(seeds, key=lambda p: _quality(_output(data, policy, p)))
    fallback = _output(data, policy, seed)
    if len(seed) < len(plans):
        fallback.detail["search_status"] = "blocked_by_zero_supply"
        return fallback
    horizon = max(w for candidate in seeds for rows in candidate.values() for w, _, _ in rows)
    if policy.strict_deadline:
        horizon = max(cal.week_of(c.planned_completion_date) for c in data.contracts)
    slots = max(4, max(s for rows in seed.values() for _, s, _ in rows))
    slots = min(slots, len(plans))
    model = cp_model.CpModel()
    x, active, eclo, end = {}, {}, {}, {}
    at_location, at_contract = defaultdict(list), defaultdict(list)
    terms = []
    windows = {line.line_code: model.new_int_var(1, max(1, horizon), f"window_{line.line_code}")
               for line in data.lines} if policy.continuity else {}
    for aid, p in plans.items():
        a, c = p.activity, contracts[p.activity.contract_number]
        last = horizon
        if policy.strict_deadline:
            # A week completes on its final day, including mid-week deadlines.
            last = min(last, ((c.planned_completion_date - cal.start).days + 1) // 7)
        weeks = range(p.earliest_week, last + 1)
        for w in weeks:
            av = active[aid, w] = model.new_bool_var(f"a_{aid}_{w}")
            ev = eclo[aid, w] = model.new_bool_var(f"e_{aid}_{w}")
            model.add(ev <= av)
            if not policy.eclo:
                model.add(ev == 0)
            if policy.continuity:
                for line in p.lines_touched:
                    model.add(w >= windows[line]).only_enforce_if(ev)
                    model.add(w <= windows[line] + 1).only_enforce_if(ev)
            choices = []
            for s in range(1, slots + 1):
                v = x[aid, w, s] = model.new_bool_var(f"x_{aid}_{w}_{s}")
                choices.append(v)
                for loc in p.path:
                    at_location[loc, w, s].append((aid, v))
                at_contract[a.contract_number, a.activity_type, w, s].append(v)
            model.add(sum(choices) == av)
            terms.append(50 * ev)
        model.add(sum(2 * active[aid, w] + eclo[aid, w] for w in weeks) >= math.ceil(a.total_accesses * 2 - 1e-9))
        # No gratuitous extra accesses: one final access may overshoot fractional demand.
        model.add(sum(active[aid, w] for w in weeks) <= math.ceil(a.total_accesses))
        end[aid] = model.new_int_var(0, horizon, f"end_{aid}")
        model.add_max_equality(end[aid], [w * active[aid, w] for w in weeks] + [0])
        if policy.delay_cost:
            late = model.new_int_var(0, max(0, horizon * 7 + abs((c.planned_completion_date - cal.start).days)), f"late_{aid}")
            model.add_max_equality(late, [0, 7 * end[aid] - 1 - (c.planned_completion_date - cal.start).days])
            weight = {1: 100, 2: 10, 3: 1}[c.contract_priority] * {1: 13, 2: 12, 3: 10}[a.activity_priority]
            terms.append(weight * late)
    for aid, p in plans.items():
        pred = p.activity.predecessor_activity_id
        if pred:
            for a, w in active:
                if a == aid:
                    model.add(w > end[pred]).only_enforce_if(active[a, w])
    for a, b in conflict_pairs(plans, contracts):
        for w in range(1, horizon + 1):
            if (a, w) in active and (b, w) in active:
                for s in range(1, slots + 1):
                    model.add(x[a, w, s] + x[b, w, s] <= 1)
    location_used = defaultdict(list)
    for (loc, w, s), entries in at_location.items():
        used = model.new_bool_var(f"loc_{loc}_{w}_{s}")
        model.add_max_equality(used, [v for _, v in entries])
        # PM occupies all four places; PC/C occupy one. Only one PC is legal.
        model.add(sum((4 if contracts[plans[a].activity.contract_number].access_type == "PM" else 1) * v
                      for a, v in entries) <= 4)
        model.add(sum(v for a, v in entries if contracts[plans[a].activity.contract_number].access_type == "PC") <= 1)
        location_used[loc, w].append(used)
    for (loc, w), used in location_used.items():
        cap = net.capacity(loc, w)
        if policy.excess is not None:
            model.add(sum(used) <= cap + policy.excess)
        excess = model.new_int_var(0, slots, f"excess_{loc}_{w}")
        model.add_max_equality(excess, [0, sum(used) - cap])
        terms.append(70 * excess)
    contract_used = defaultdict(list)
    for (cn, typ, w, s), entries in at_contract.items():
        used = model.new_bool_var(f"contract_{cn}_{typ}_{w}_{s}")
        model.add_max_equality(used, entries)
        model.add(sum(entries) <= contracts[cn].number_of_workfronts)
        contract_used[cn, typ, w].append(used)
    for (cn, _, _), used in contract_used.items():
        model.add(sum(used) <= contracts[cn].number_of_maximum_access_per_week)
    model.minimize(sum(terms))
    seed_map = {(a, w): (s, e) for a, rows in seed.items() for w, s, e in rows}
    for (a, w, s), v in x.items():
        model.add_hint(v, int(seed_map.get((a, w), (0, 0))[0] == s))
    for key, v in eclo.items():
        model.add_hint(v, seed_map.get(key, (0, 0))[1])
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = float(os.getenv("SOLVER_TIME_LIMIT_SECONDS", "15"))
    solver.parameters.num_search_workers = 4
    solver.parameters.random_seed = 42
    status = solver.solve(model)
    detail = {"search_status": solver.status_name(status), "search_horizon_weeks": horizon,
              "possession_night_palette": slots, "bounded_model": True,
              "search_seconds": round(solver.wall_time, 3),
              "objective_bound": solver.best_objective_bound / 10 if status in (cp_model.FEASIBLE, cp_model.OPTIMAL) else None}
    if status in (cp_model.FEASIBLE, cp_model.OPTIMAL):
        placements = defaultdict(list)
        for (a, w, s), v in x.items():
            if solver.value(v):
                placements[a].append((w, s, solver.value(eclo[a, w])))
        candidate = _output(data, policy, placements, detail)
        if _quality(candidate) <= _quality(fallback):
            return candidate
    fallback.detail.update(detail, fallback_used=True)
    return fallback
