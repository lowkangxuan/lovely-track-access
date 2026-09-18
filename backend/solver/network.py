"""
Network geometry: location-id parsing, path expansion (book-in -> book-out),
buffer footprints (incl. 750V mirroring and the H01_H02 interchange crossover),
and horizon week arithmetic.

Location id grammar
-------------------
    SEC:<LINE>:<FROM>_<TO>:<BOUND>     tunnel sector
    PLAT:<LINE>:<STATION>:<BOUND>      platform sector

`03_SECTORS.csv` / `04_LOCATION_SUPPLY.csv` carry the un-bounded sector ids;
the bound suffix is appended per activity.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Dict, List, Optional, Set, Tuple

from .schemas import Activity, InstanceData

OPPOSITE = {"EB": "WB", "WB": "EB"}
INTERCHANGE_SECTOR_KEY = "H01_H02"


# --------------------------------------------------------------------------- #
# location ids                                                                 #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class LocationRef:
    kind: str          # "SEC" | "PLAT"
    line: str
    key: str           # "S01_S02" for SEC, "S03" for PLAT
    bound: str         # "EB" | "WB" | ""

    @property
    def id(self) -> str:
        parts = [self.kind, self.line, self.key]
        if self.bound:
            parts.append(self.bound)
        return ":".join(parts)


def parse_location(loc_id: str) -> Optional[LocationRef]:
    parts = [p for p in (loc_id or "").strip().split(":") if p != ""]
    if len(parts) < 3:
        return None
    kind, line, key = parts[0].upper(), parts[1].upper(), parts[2]
    bound = parts[3].upper() if len(parts) > 3 else ""
    if kind not in ("SEC", "PLAT"):
        return None
    return LocationRef(kind=kind, line=line, key=key, bound=bound)


# --------------------------------------------------------------------------- #
# network                                                                      #
# --------------------------------------------------------------------------- #


@dataclass
class Network:
    """Ordered station / sector chains per line, with O(1) index lookups."""

    stations_by_line: Dict[str, List[str]] = field(default_factory=dict)
    sector_keys_by_line: Dict[str, List[str]] = field(default_factory=dict)
    station_index: Dict[Tuple[str, str], int] = field(default_factory=dict)
    sector_index: Dict[Tuple[str, str], int] = field(default_factory=dict)
    known_locations: Set[str] = field(default_factory=set)
    supply: Dict[str, int] = field(default_factory=dict)

    @classmethod
    def build(cls, data: InstanceData) -> "Network":
        net = cls()
        by_line: Dict[str, List[Tuple[int, str]]] = {}
        for st in data.stations:
            by_line.setdefault(st.line_code, []).append((st.seq, st.station_id))
        for line, items in by_line.items():
            ordered = [sid for _, sid in sorted(items)]
            net.stations_by_line[line] = ordered
            for i, sid in enumerate(ordered):
                net.station_index[(line, sid)] = i

        sec_by_line: Dict[str, List[Tuple[int, str]]] = {}
        for sec in data.sectors:
            key = f"{sec.from_station_id}_{sec.to_station_id}"
            order = net.station_index.get((sec.line_code, sec.from_station_id), sec.seq)
            sec_by_line.setdefault(sec.line_code, []).append((order, key))
        for line, items in sec_by_line.items():
            ordered = [k for _, k in sorted(items)]
            net.sector_keys_by_line[line] = ordered
            for i, k in enumerate(ordered):
                net.sector_index[(line, k)] = i

        net.supply = data.supply_map()
        net.known_locations = set(net.supply.keys())
        return net

    # -- path ------------------------------------------------------------- #

    def expand_path(self, start_id: str, end_id: str) -> List[str]:
        """
        Every tunnel sector AND platform sector occupied by work running from
        `start_id` to `end_id`, inclusive of both endpoints.
        """
        a, b = parse_location(start_id), parse_location(end_id or start_id)
        if a is None:
            return []
        if b is None:
            b = a
        line = a.line
        bound = a.bound or b.bound or "EB"

        sec_keys = self.sector_keys_by_line.get(line, [])
        stations = self.stations_by_line.get(line, [])
        if not sec_keys or not stations:
            return [x for x in {a.id, b.id} if x]

        def sec_span(ref: LocationRef) -> Optional[Tuple[int, int]]:
            if ref.kind == "SEC":
                i = self.sector_index.get((ref.line, ref.key))
                return (i, i) if i is not None else None
            # a platform: the sectors either side of it
            si = self.station_index.get((ref.line, ref.key))
            if si is None:
                return None
            lo = max(0, si - 1)
            hi = min(len(sec_keys) - 1, si)
            return (lo, hi)

        sa, sb = sec_span(a), sec_span(b)
        if sa is None or sb is None:
            return [x for x in {a.id, b.id} if x]

        lo = min(sa[0], sb[0])
        hi = max(sa[1], sb[1])

        locations: List[str] = []
        for i in range(lo, hi + 1):
            locations.append(f"SEC:{line}:{sec_keys[i]}:{bound}")

        # platforms: every station touched, from the first sector's "from"
        # station through the last sector's "to" station.
        first_from = sec_keys[lo].split("_")[0]
        last_to = sec_keys[hi].split("_")[-1]
        i0 = self.station_index.get((line, first_from), 0)
        i1 = self.station_index.get((line, last_to), len(stations) - 1)
        for i in range(min(i0, i1), max(i0, i1) + 1):
            locations.append(f"PLAT:{line}:{stations[i]}:{bound}")

        # keep only locations the instance actually declares supply for
        out = [l for l in locations if not self.known_locations or l in self.known_locations]
        return out or locations

    # -- buffers ----------------------------------------------------------- #

    def buffer_footprint(
        self,
        path: List[str],
        buffer_sectors: int,
        mirror_opposite: bool,
    ) -> List[str]:
        """
        Exclusion zone around `path`.

        * `buffer_sectors` tunnel sectors ahead and behind on the same bound
          (plus the platforms in between).
        * `mirror_opposite` (Live / 750V) mirrors the whole closure onto the
          opposite bound, and additionally crosses onto the *other line's*
          H01_H02 tunnel sector and H01/H02 platforms at the interchange.
        """
        footprint: Set[str] = set()
        by_line_bound: Dict[Tuple[str, str], List[int]] = {}

        for loc_id in path:
            ref = parse_location(loc_id)
            if ref is None or ref.kind != "SEC":
                continue
            i = self.sector_index.get((ref.line, ref.key))
            if i is not None:
                by_line_bound.setdefault((ref.line, ref.bound), []).append(i)

        # The exclusion ring is measured in tunnel sectors (05_BUFFER_LOCATION
        # is denominated in sectors); platforms enter the footprint only where
        # they are actually worked, i.e. via `path` below.
        if buffer_sectors > 0:
            for (line, bound), idxs in by_line_bound.items():
                sec_keys = self.sector_keys_by_line.get(line, [])
                lo, hi = min(idxs), max(idxs)
                for i in range(max(0, lo - buffer_sectors), min(len(sec_keys) - 1, hi + buffer_sectors) + 1):
                    footprint.add(f"SEC:{line}:{sec_keys[i]}:{bound}")
        footprint.update(path)

        if mirror_opposite:
            mirrored: Set[str] = set()
            for loc_id in list(footprint):
                ref = parse_location(loc_id)
                if ref is None or ref.bound not in OPPOSITE:
                    continue
                mirrored.add(
                    LocationRef(ref.kind, ref.line, ref.key, OPPOSITE[ref.bound]).id
                )
            footprint |= mirrored

            # 750V interchange crossover: closing the traction power at H01_H02
            # closes the other line's H01_H02 tunnel and H01/H02 platforms too.
            touches_interchange = any(
                (r := parse_location(l)) and r.kind == "SEC" and r.key == INTERCHANGE_SECTOR_KEY
                for l in footprint
            )
            if touches_interchange:
                for line in self.sector_keys_by_line:
                    for bound in ("EB", "WB"):
                        footprint.add(f"SEC:{line}:{INTERCHANGE_SECTOR_KEY}:{bound}")
                        for hub in ("H01", "H02"):
                            footprint.add(f"PLAT:{line}:{hub}:{bound}")

        if self.known_locations:
            footprint = {l for l in footprint if l in self.known_locations}
        return sorted(footprint)

    def capacity(self, location_id: str) -> int:
        return self.supply.get(location_id, 0)


# --------------------------------------------------------------------------- #
# week arithmetic                                                              #
# --------------------------------------------------------------------------- #


class Calendar:
    """Week 1 == the week containing `horizon_start`."""

    def __init__(self, horizon_start: date, horizon_weeks: int):
        self.start = horizon_start
        self.weeks = horizon_weeks

    def week_of(self, d: Optional[date]) -> int:
        if d is None:
            return 1
        return max(1, (d - self.start).days // 7 + 1)

    def monday_of(self, week: int) -> date:
        return self.start + timedelta(days=(week - 1) * 7)

    def sunday_of(self, week: int) -> date:
        return self.monday_of(week) + timedelta(days=6)


# --------------------------------------------------------------------------- #
# per-activity precomputation                                                  #
# --------------------------------------------------------------------------- #


@dataclass
class ActivityPlan:
    activity: Activity
    path: List[str]
    buffer_zone: List[str]
    carries_buffer: bool
    lines_touched: Set[str]
    earliest_week: int
    nights_required: float


def build_activity_plans(
    data: InstanceData, net: Network, cal: Calendar
) -> Dict[str, ActivityPlan]:
    contracts = data.contract_map()
    buffer_rules = data.buffer_map()
    plans: Dict[str, ActivityPlan] = {}

    for act in data.activities:
        contract = contracts.get(act.contract_number)
        nature = (contract.nature_of_activity if contract else "").strip().lower()
        rule = buffer_rules.get(nature)
        buf_sectors = rule.up_to_buffer_sectors if rule else 0
        mirror = bool(rule.opposite_bound_required) if rule else False

        path = net.expand_path(act.start_location_id, act.end_location_id)
        zone = net.buffer_footprint(path, buf_sectors, mirror)
        lines = {
            r.line for l in path if (r := parse_location(l)) is not None
        }
        plans[act.activity_id] = ActivityPlan(
            activity=act,
            path=path,
            buffer_zone=zone,
            carries_buffer=buf_sectors > 0 or mirror,
            lines_touched=lines,
            earliest_week=cal.week_of(act.planned_start_date),
            nights_required=float(act.total_accesses),
        )
    return plans


def topological_order(
    data: InstanceData, rank: Optional[Dict[str, float]] = None
) -> List[str]:
    """
    Predecessor-respecting order (rule 3). `rank` is an optional tie-break
    priority (lower goes first); without it, contract tier then activity tier.
    Cycles are broken deterministically rather than raising.
    """
    contracts = data.contract_map()
    acts = data.activity_map()

    def sort_key(aid: str):
        a = acts[aid]
        c = contracts.get(a.contract_number)
        if rank is not None:
            return (rank.get(aid, 0.0), a.activity_id)
        return (
            c.contract_priority if c else 3,
            a.activity_priority,
            a.planned_start_date or date.max,
            -a.total_accesses,
            a.activity_id,
        )

    pending = sorted(acts.keys(), key=sort_key)
    placed: Set[str] = set()
    order: List[str] = []
    guard = 0
    while pending and guard < len(acts) + 5:
        guard += 1
        progressed = False
        remaining: List[str] = []
        for aid in pending:
            pred = acts[aid].predecessor_activity_id
            if pred and pred in acts and pred not in placed:
                remaining.append(aid)
                continue
            order.append(aid)
            placed.add(aid)
            progressed = True
        pending = remaining
        if not progressed:
            break
    order.extend(pending)  # cycle fallback
    return order
