"""
Soft scores + the combined objective from PS1 §2.5 / §2.7.

Weights
-------
contract tier weight : 100 / 10 / 1   for contract_priority 1 / 2 / 3
activity nudge       : +0.3 / +0.2 / +0.0 for activity_priority 1 / 2 / 3
excess access-night  : 7x   (Scenarios B and C)
ECLO night           : 5x   (Scenarios B and C; hard-forbidden in A)
"""

from __future__ import annotations

from collections import defaultdict
from typing import Dict, List

from .network import Calendar, Network
from .schemas import AccessRow, InstanceData, OccupancyRow, ResultRow, SoftScores

CONTRACT_WEIGHT = {1: 100.0, 2: 10.0, 3: 1.0}
ACTIVITY_NUDGE = {1: 0.3, 2: 0.2, 3: 0.0}
EXCESS_NIGHT_WEIGHT = 7.0
ECLO_WEIGHT = 5.0
FORMULA_VERSION = "ps1-2.5"


def build_results(
    data: InstanceData,
    cal: Calendar,
    access: List[AccessRow],
    scenario: str,
) -> List[ResultRow]:
    last_week: Dict[str, int] = {}
    acts = data.activity_map()
    for row in access:
        act = acts.get(row.activity_id)
        if not act:
            continue
        cn = act.contract_number
        last_week[cn] = max(last_week.get(cn, 0), row.week)

    out: List[ResultRow] = []
    for c in data.contracts:
        w = last_week.get(c.contract_number)
        sim = cal.sunday_of(w) if w else (c.planned_completion_date or cal.sunday_of(1))
        planned = c.planned_completion_date
        overrun = max(0, (sim - planned).days) if planned else 0
        out.append(
            ResultRow(
                scenario=scenario,
                contract_number=c.contract_number,
                simulated_completion_date=sim.isoformat(),
                overrun_days=overrun,
            )
        )
    return out


def excess_access_nights(
    data: InstanceData, occupancy: List[OccupancyRow]
) -> tuple[int, List[dict]]:
    """Slots used beyond supply_capacity (net of weather outages), summed over location-weeks."""
    net = Network.build(data)
    used: Dict[tuple, set] = defaultdict(set)
    for row in occupancy:
        used[(row.location_id, row.week)].add(row.co_share_group)

    total = 0
    hotspots: List[dict] = []
    for (loc, week), groups in used.items():
        cap = net.capacity(loc, week)
        n = len(groups)
        if n > cap:
            total += n - cap
            hotspots.append(
                {"location_id": loc, "week": week, "used": n, "capacity": cap, "excess": n - cap}
            )
        elif cap and n == cap:
            hotspots.append(
                {"location_id": loc, "week": week, "used": n, "capacity": cap, "excess": 0}
            )
    hotspots.sort(key=lambda h: (-h["excess"], -h["used"], h["location_id"]))
    return total, hotspots[:40]


def compute_soft_scores(
    data: InstanceData,
    cal: Calendar,
    scenario: str,
    access: List[AccessRow],
    occupancy: List[OccupancyRow],
    results: List[ResultRow],
    feasible: bool,
) -> tuple[SoftScores, List[dict]]:
    contracts = data.contract_map()
    acts = data.activity_map()

    overrun_by_contract = {r.contract_number: r.overrun_days for r in results}
    overrun_total = sum(overrun_by_contract.values())
    contracts_overrunning = sum(1 for v in overrun_by_contract.values() if v > 0)

    earliness = 0
    for r in results:
        c = contracts.get(r.contract_number)
        if c and c.planned_completion_date and r.overrun_days == 0:
            from datetime import date as _date

            sim = _date.fromisoformat(r.simulated_completion_date)
            earliness += max(0, (c.planned_completion_date - sim).days)

    priority_overrun: Dict[str, int] = {"1": 0, "2": 0, "3": 0}
    for cn, days in overrun_by_contract.items():
        c = contracts.get(cn)
        tier = str(c.contract_priority if c else 3)
        priority_overrun[tier] = priority_overrun.get(tier, 0) + days

    # priority_weighted_score: per overrunning activity, banded by contract tier
    last_week_by_activity: Dict[str, int] = {}
    for row in access:
        last_week_by_activity[row.activity_id] = max(
            last_week_by_activity.get(row.activity_id, 0), row.week
        )
    weighted = 0.0
    for aid, wk in last_week_by_activity.items():
        act = acts.get(aid)
        if not act:
            continue
        c = contracts.get(act.contract_number)
        if not c or not c.planned_completion_date:
            continue
        days = max(0, (cal.sunday_of(wk) - c.planned_completion_date).days)
        if days <= 0:
            continue
        weight = CONTRACT_WEIGHT.get(c.contract_priority, 1.0)
        nudge = ACTIVITY_NUDGE.get(act.activity_priority, 0.0)
        weighted += weight * (1.0 + nudge) * days

    excess, hotspots = excess_access_nights(data, occupancy)
    eclo_nights = sum(1 for r in access if r.eclo)

    scores = SoftScores(
        scenario=scenario,
        overrun_days_total=overrun_total,
        contracts_overrunning=contracts_overrunning,
        earliness_days_total=earliness,
        excess_access_nights_total=excess,
        eclo_nights_total=eclo_nights,
        priority_overrun=priority_overrun,
        priority_weighted_score=round(weighted, 2),
    )

    if feasible:
        if scenario == "A":
            obj = weighted
        elif scenario == "B":
            obj = EXCESS_NIGHT_WEIGHT * excess + ECLO_WEIGHT * eclo_nights
        else:
            obj = weighted + EXCESS_NIGHT_WEIGHT * excess + ECLO_WEIGHT * eclo_nights
        scores.objective_score = round(obj, 2)
        scores.formula_version = FORMULA_VERSION

    return scores, hotspots
