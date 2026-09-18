"""Read-only checks of emitted submissions, independent of search decisions.

Our exports use one possession-night label across an activity's entire path.
This also supplies a consistent physical-night witness for closure checks.
"""
from collections import defaultdict
from itertools import combinations

from .network import Calendar, Network, build_activity_plans
from .schemas import Violation
from .scoring import build_results


def validate_schedule(data, out):
    violations = []

    def fail(rule, detail):
        violations.append(Violation(rule=rule, detail=detail))

    cal = Calendar(data.parameters.horizon_start, data.parameters.horizon_weeks)
    net = Network.build(data)
    plans = build_activity_plans(data, net, cal)
    contracts, acts = data.contract_map(), data.activity_map()
    access, occupancy = defaultdict(list), defaultdict(list)
    for r in out.schedule_access:
        if r.activity_id not in acts:
            fail("workload", f"Unknown activity {r.activity_id}")
            continue
        access[r.activity_id].append(r)
    for r in out.schedule_occupancy:
        occupancy[r.activity_id, r.week].append(r)
    location_groups, supply_groups = defaultdict(list), defaultdict(set)
    night_groups, contract_nights, windows = defaultdict(set), defaultdict(set), defaultdict(list)
    physical, local_to_physical, physical_to_local = defaultdict(list), {}, {}
    access_keys = set()
    for aid, a in acts.items():
        rows = sorted(access[aid], key=lambda r: (r.week, r.access_seq))
        c, p = contracts[a.contract_number], plans[aid]
        if not rows or sum(1.5 if r.eclo == 1 else 1 for r in rows) + 1e-9 < a.total_accesses:
            fail("workload", f"{aid}: full workload of {a.total_accesses} not delivered")
        if [r.access_seq for r in rows] != list(range(1, len(rows) + 1)):
            fail("sequence", f"{aid}: access_seq must be consecutive and chronological")
        if len({r.week for r in rows}) != len(rows):
            fail("weekly_access", f"{aid}: at most one access per week")
        if a.predecessor_activity_id and rows:
            pred = access[a.predecessor_activity_id]
            if not pred or rows[0].week <= max(r.week for r in pred):
                fail("predecessor", f"{aid}: must start in a later week than {a.predecessor_activity_id} finishes")
        for r in rows:
            key = (aid, r.week)
            access_keys.add(key)
            if r.week < p.earliest_week or r.week < 1:
                fail("planned_start", f"{aid} wk{r.week}: starts before planned start week")
            if r.eclo not in (0, 1) or (out.scenario == "A" and r.eclo):
                fail("eclo", f"{aid} wk{r.week}: invalid ECLO for scenario {out.scenario}")
            if not 1 <= r.access_night <= c.number_of_maximum_access_per_week:
                fail("allocation", f"{aid} wk{r.week}: invalid access_night")
            ck = (a.contract_number, a.activity_type, r.week)
            contract_nights[ck].add(r.access_night)
            night_groups[(*ck, r.access_night)].add(aid)
            if r.eclo:
                for line in p.lines_touched:
                    windows[line].append(r.week)
            occ = occupancy[key]
            if sorted(o.location_id for o in occ) != sorted(p.path):
                fail("occupancy", f"{aid} wk{r.week}: occupancy must contain the entire worked path exactly once")
            groups = {o.co_share_group for o in occ}
            if len(groups) != 1 or "" in groups:
                fail("occupancy", f"{aid} wk{r.week}: a consistent possession-night label is required")
            else:
                group = next(iter(groups))
                physical[r.week, group].append(aid)
                lk, pk = (*ck, r.access_night), (*ck, group)
                if lk in local_to_physical and local_to_physical[lk] != group:
                    fail("workfront", f"{aid} wk{r.week}: one local night maps to multiple possession nights")
                if pk in physical_to_local and physical_to_local[pk] != r.access_night:
                    fail("workfront", f"{aid} wk{r.week}: one possession night maps to multiple local nights")
                local_to_physical[lk], physical_to_local[pk] = group, r.access_night
            for o in occ:
                location_groups[o.location_id, o.week, o.co_share_group].append(c.access_type)
                supply_groups[o.location_id, o.week].add(o.co_share_group)
    for key in occupancy.keys() - access_keys:
        fail("occupancy", f"{key}: occupancy has no matching access")
    for key, types in location_groups.items():
        if len(types) > 4 or types.count("PC") > 1 or ("PM" in types and len(types) != 1):
            fail("mix", f"{key}: illegal possession mix {types}")
    for (loc, week), groups in supply_groups.items():
        if loc not in net.supply:
            fail("capacity", f"Unknown location {loc}")
        if out.scenario != "B" and len(groups) > net.capacity(loc, week) + (out.scenario == "C"):
            fail("capacity", f"{loc} wk{week}: {len(groups)} nights exceed supply {net.capacity(loc, week)}")
    for (cn, typ, week), nights in contract_nights.items():
        if len(nights) > contracts[cn].number_of_maximum_access_per_week:
            fail("allocation", f"{cn}/{typ} wk{week}: weekly allocation exceeded")
    for (cn, typ, week, night), members in night_groups.items():
        if len(members) > contracts[cn].number_of_workfronts:
            fail("workfront", f"{cn}/{typ} wk{week} night {night}: workfront cap exceeded")
    for (week, group), members in physical.items():
        for a, b in combinations(members, 2):
            pa, pb = plans[a], plans[b]
            ta, tb = contracts[acts[a].contract_number].access_type, contracts[acts[b].contract_number].access_type
            common_path = set(pa.path) & set(pb.path)
            exempt = common_path and "PM" not in (ta, tb) and (ta, tb) != ("PC", "PC")
            collision = set(pa.buffer_zone) & set(pb.buffer_zone)
            if collision and not exempt:
                fail("closure", f"wk{week} {group}: {a}/{b} intersect at {sorted(collision)}")
    if out.scenario == "C":
        for line, weeks in windows.items():
            if max(weeks) - min(weeks) > 1:
                fail("eclo_window", f"{line}: ECLO spans more than two consecutive calendar weeks")
    expected = build_results(data, cal, out.schedule_access, out.scenario)
    if sorted([r.model_dump() for r in expected], key=lambda r: r["contract_number"]) != sorted(
            [r.model_dump() for r in out.results], key=lambda r: r["contract_number"]):
        fail("results", "RESULTS must match actual contract completion dates and scenario")
    if out.scenario == "B":
        for r in expected:
            if r.overrun_days:
                fail("planned_date", f"{r.contract_number}: completes {r.overrun_days} days after its fixed deadline")
    return violations
