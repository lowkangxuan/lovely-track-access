"""
Distance tracking & manpower allocation.

A post-processing pass over a solved schedule: it places every station on a
plane, derives a worksite point for each scheduled activity, and assigns the
closest *eligible* engineering team from `09_FLEET_DATA.csv`.

Why this lives outside the solver
---------------------------------
Crew assignment does not change which week a possession is taken, so it does
not belong behind the `solve_scenario()` seam a team may replace. It consumes
the solve output and the network geometry, and feeds the dashboard's
`avg_travel_distance` / `expertise_match_rate` cards and the Review Team
Allocations table.

Geometry
--------
`02_STATIONS.csv` carries no coordinates, only a per-line `seq`, so the plane
is reconstructed from the running order:

    x = (seq - 1) * station_spacing_km      y = line_index * line_spacing_km

Both spacings are overridable from `06_PARAMETERS.csv` (`station_spacing_km`,
`line_spacing_km`). A station that appears on more than one line — the H01/H02
interchange — sits at the mean of its per-line positions, so the interchange is
a single physical place rather than two. Sector points are the midpoint of
their two stations; an activity's worksite is the centroid of every location on
its booked path.

Matching
--------
* Required specialty — `Live` when the contract's `nature_of_activity` is live
  work, otherwise the activity's own `activity_type`.
* Required tier — from `activity_priority`: P1 -> Tier 1, P2 -> Tier 2,
  P3 -> Tier 3. A higher-tier crew may work down (Tier 1 can take Tier 3 work),
  never up.
* Among the teams clearing both bars, the nearest wins. A soft workload cap
  spreads the work so one well-placed depot cannot absorb the whole horizon;
  when every eligible team is at cap the cap is ignored rather than leaving the
  activity unassigned.
* If nothing is eligible at all, the globally nearest team is assigned and the
  row is flagged as an expertise shortfall — visible, never silently dropped.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

from .network import Network, parse_location
from .schemas import Activity, FleetTeam, InstanceData

DEFAULT_STATION_SPACING_KM = 2.5
DEFAULT_LINE_SPACING_KM = 4.0

#: activity_priority -> the tier a crew must be at least as good as
TIER_FOR_PRIORITY = {1: 1, 2: 2, 3: 3}

#: how much more than an even share of the activities one team may absorb
WORKLOAD_HEADROOM = 1.5

Point = Tuple[float, float]


# --------------------------------------------------------------------------- #
# geometry                                                                     #
# --------------------------------------------------------------------------- #


def _float_param(extra: Dict[str, str], key: str, default: float) -> float:
    try:
        value = float(str(extra.get(key, "")).strip())
    except (TypeError, ValueError):
        return default
    return value if math.isfinite(value) and value > 0 else default


def station_coordinates(data: InstanceData) -> Dict[str, Point]:
    """
    `station_id` -> (x, y) in kilometres.

    Stations shared between lines (the interchange) collapse to the mean of
    their per-line positions.
    """
    spacing = _float_param(data.parameters.extra, "station_spacing_km", DEFAULT_STATION_SPACING_KM)
    line_gap = _float_param(data.parameters.extra, "line_spacing_km", DEFAULT_LINE_SPACING_KM)

    line_order = {line.line_code: i for i, line in enumerate(data.lines)}
    for station in data.stations:  # tolerate a line that only appears in 02_STATIONS
        line_order.setdefault(station.line_code, len(line_order))

    samples: Dict[str, List[Point]] = {}
    for station in data.stations:
        x = (station.seq - 1) * spacing
        y = line_order.get(station.line_code, 0) * line_gap
        samples.setdefault(station.station_id, []).append((x, y))

    return {
        sid: (
            round(sum(p[0] for p in pts) / len(pts), 4),
            round(sum(p[1] for p in pts) / len(pts), 4),
        )
        for sid, pts in samples.items()
    }


def location_point(location_id: str, coords: Dict[str, Point]) -> Optional[Point]:
    """Centre of a `SEC:` or `PLAT:` location — sectors are the midpoint of their stations."""
    ref = parse_location(location_id)
    if ref is None:
        return None
    if ref.kind == "PLAT":
        return coords.get(ref.key)
    points = [coords[s] for s in ref.key.split("_") if s in coords]
    if not points:
        return None
    return (
        sum(p[0] for p in points) / len(points),
        sum(p[1] for p in points) / len(points),
    )


def centroid(points: Sequence[Point]) -> Optional[Point]:
    if not points:
        return None
    return (
        round(sum(p[0] for p in points) / len(points), 4),
        round(sum(p[1] for p in points) / len(points), 4),
    )


def distance_km(a: Point, b: Point) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


# --------------------------------------------------------------------------- #
# fleet                                                                        #
# --------------------------------------------------------------------------- #

_TIER_DIGITS = re.compile(r"(\d+)")


def tier_number(label: str) -> int:
    """'Tier 2' / 'tier-2' / '2' -> 2. Anything unparseable is treated as the lowest tier."""
    match = _TIER_DIGITS.search(str(label or ""))
    return int(match.group(1)) if match else 99


def tier_label(number: int) -> str:
    return f"Tier {number}" if number < 99 else "Untiered"


@dataclass
class TeamSite:
    """A fleet team resolved onto the network plane."""

    team: FleetTeam
    point: Point
    tier: int
    specialty: str
    #: True when the coordinates came from the CSV rather than the base station
    explicit_coords: bool


def resolve_fleet(data: InstanceData, coords: Dict[str, Point]) -> List[TeamSite]:
    """
    Place every team. `coord_x`/`coord_y` win when supplied; otherwise the team
    sits on its `base_station_id`, and failing that at the network origin.
    """
    sites: List[TeamSite] = []
    for team in data.fleet:
        explicit = team.coord_x is not None and team.coord_y is not None
        if explicit:
            point = (float(team.coord_x), float(team.coord_y))
        else:
            point = coords.get(team.base_station_id, (0.0, 0.0))
        sites.append(
            TeamSite(
                team=team,
                point=point,
                tier=tier_number(team.expertise_tier),
                specialty=(team.activity_type_specialty or "").strip(),
                explicit_coords=explicit,
            )
        )
    return sites


def required_specialty(activity: Activity, nature_of_activity: str) -> str:
    """Live work needs a live-rail crew whatever the activity type says."""
    if (nature_of_activity or "").strip().lower().startswith("live"):
        return "Live"
    return (activity.activity_type or "").strip()


def _specialty_ok(site: TeamSite, wanted: str) -> bool:
    if not wanted:
        return True
    return site.specialty.strip().lower() == wanted.strip().lower()


# --------------------------------------------------------------------------- #
# allocation                                                                   #
# --------------------------------------------------------------------------- #


def allocate_teams(
    data: InstanceData,
    net: Network,
    scheduled: Dict[str, dict],
) -> dict:
    """
    Assign a crew to every scheduled activity.

    `scheduled` maps activity_id -> {"access_nights": int, "first_week": int,
    "last_week": int, "locations": [location_id]} for the activities the solver
    actually placed. Returns the `allocation` block of the view-model; an empty
    fleet yields null metrics so the UI can say "no fleet data" rather than
    showing a fabricated zero.
    """
    coords = station_coordinates(data)
    sites = resolve_fleet(data, coords)
    contracts = data.contract_map()
    acts = data.activity_map()

    if not sites or not scheduled:
        return {
            "available": bool(sites),
            "teams_total": len(sites),
            "teams_utilised": 0,
            "activities_allocated": 0,
            "avg_travel_distance": None,
            "total_travel_distance": None,
            "max_travel_distance": None,
            "expertise_match_rate": None,
            "nearest_team_match_rate": None,
            "unmatched_expertise": 0,
            "team_allocations": [],
            "teams": [_team_summary(s, 0, 0.0) for s in sites],
        }

    cap = max(1, math.ceil(len(scheduled) / len(sites) * WORKLOAD_HEADROOM))
    load: Dict[str, int] = {s.team.team_id: 0 for s in sites}
    travelled: Dict[str, float] = {s.team.team_id: 0.0 for s in sites}

    # highest-priority activities pick their crew first
    order = sorted(
        scheduled,
        key=lambda aid: (
            acts[aid].activity_priority if aid in acts else 3,
            contracts[acts[aid].contract_number].contract_priority
            if aid in acts and acts[aid].contract_number in contracts
            else 3,
            aid,
        ),
    )

    rows: List[dict] = []
    for activity_id in order:
        act = acts.get(activity_id)
        if act is None:
            continue
        info = scheduled[activity_id]
        contract = contracts.get(act.contract_number)

        path = info.get("locations") or net.expand_path(act.start_location_id, act.end_location_id)
        points = [p for p in (location_point(loc, coords) for loc in path) if p is not None]
        worksite = centroid(points) or location_point(act.start_location_id, coords) or (0.0, 0.0)

        wanted = required_specialty(act, contract.nature_of_activity if contract else "")
        need_tier = TIER_FOR_PRIORITY.get(act.activity_priority, 3)

        ranked = sorted(sites, key=lambda s: (distance_km(worksite, s.point), s.team.team_id))
        eligible = [s for s in ranked if _specialty_ok(s, wanted) and s.tier <= need_tier]

        # The benchmark is the nearest crew that *could* do the job; when none
        # qualifies, the nearest crew of any kind.
        nearest = (eligible or ranked)[0]
        nearest_any = ranked[0]

        pool = [s for s in eligible if load[s.team.team_id] < cap] or eligible or ranked
        chosen = pool[0]

        dist = distance_km(worksite, chosen.point)
        load[chosen.team.team_id] += 1
        travelled[chosen.team.team_id] += dist

        # Round once, then derive the detour from the rounded figures, so the
        # three numbers the table puts side by side actually add up.
        travel_km = round(dist, 2)
        nearest_km = round(distance_km(worksite, nearest.point), 2)

        specialty_ok = _specialty_ok(chosen, wanted)
        tier_ok = chosen.tier <= need_tier
        match_pct = round((50 if specialty_ok else 0) + (50 if tier_ok else 0), 1)

        rows.append(
            {
                "activity_id": activity_id,
                "contract_number": act.contract_number,
                "activity_type": act.activity_type,
                "activity_priority": act.activity_priority,
                "nature_of_activity": contract.nature_of_activity if contract else "",
                # --- worksite ---------------------------------------------- #
                "worksite_location_id": act.start_location_id,
                "worksite_label": act.start_location_id
                if act.end_location_id == act.start_location_id
                else f"{act.start_location_id} → {act.end_location_id}",
                "worksite_x": round(worksite[0], 2),
                "worksite_y": round(worksite[1], 2),
                "worksite_locations": len(path),
                # --- crew --------------------------------------------------- #
                "team_id": chosen.team.team_id,
                "base_station_id": chosen.team.base_station_id,
                "team_x": round(chosen.point[0], 2),
                "team_y": round(chosen.point[1], 2),
                "travel_distance_km": travel_km,
                # --- proximity ---------------------------------------------- #
                # "closest" = closest *eligible* crew; a False flag therefore
                # means workload balancing moved the job, not a skills gap.
                "closest_team_id": nearest.team.team_id,
                "closest_team_distance_km": nearest_km,
                "closest_team_match": chosen.team.team_id == nearest.team.team_id,
                "detour_km": round(travel_km - nearest_km, 2),
                "nearest_any_team_id": nearest_any.team.team_id,
                "nearest_any_distance_km": round(distance_km(worksite, nearest_any.point), 2),
                # --- expertise ---------------------------------------------- #
                "required_specialty": wanted,
                "team_specialty": chosen.specialty,
                "required_tier": need_tier,
                "required_tier_label": tier_label(need_tier),
                "team_tier": chosen.tier,
                "expertise_tier": tier_label(chosen.tier),
                "specialty_match": specialty_ok,
                "tier_match": tier_ok,
                "expertise_match": specialty_ok and tier_ok,
                "expertise_match_pct": match_pct,
                "expertise_summary": f"{tier_label(chosen.tier)} — {match_pct:g}% match",
                # --- schedule context ---------------------------------------- #
                "access_nights": info.get("access_nights", 0),
                "first_week": info.get("first_week"),
                "last_week": info.get("last_week"),
            }
        )

    rows.sort(key=lambda r: (r["contract_number"], r["activity_id"]))
    distances = [r["travel_distance_km"] for r in rows]
    matched = sum(1 for r in rows if r["expertise_match"])
    nearest_hits = sum(1 for r in rows if r["closest_team_match"])

    return {
        "available": True,
        "teams_total": len(sites),
        "teams_utilised": sum(1 for v in load.values() if v),
        "activities_allocated": len(rows),
        "avg_travel_distance": round(sum(distances) / len(distances), 2),
        "total_travel_distance": round(sum(distances), 2),
        "max_travel_distance": round(max(distances), 2),
        "expertise_match_rate": round(matched / len(rows) * 100, 1),
        "nearest_team_match_rate": round(nearest_hits / len(rows) * 100, 1),
        "unmatched_expertise": len(rows) - matched,
        "workload_cap": cap,
        "team_allocations": rows,
        "teams": [_team_summary(s, load[s.team.team_id], travelled[s.team.team_id]) for s in sites],
    }


def _team_summary(site: TeamSite, assignments: int, travelled: float) -> dict:
    return {
        "team_id": site.team.team_id,
        "base_station_id": site.team.base_station_id,
        "coord_x": round(site.point[0], 2),
        "coord_y": round(site.point[1], 2),
        "activity_type_specialty": site.specialty,
        "expertise_tier": tier_label(site.tier),
        "assignments": assignments,
        "travel_distance_km": round(travelled, 2),
    }
