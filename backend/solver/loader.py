"""
CSV -> InstanceData parsing, plus header validation shared with the frontend.

Every parser is defensive: unknown extra columns are ignored, blanks become
None, and a bad header raises CsvSchemaError with a message the UI can show
verbatim.
"""

from __future__ import annotations

import csv
import io
import math
from datetime import date, datetime
from typing import Dict, List, Optional, Sequence

from .schemas import (
    ALL_HEADERS,
    OPTIONAL_HEADERS,
    REQUIRED_HEADERS,
    Activity,
    BufferRule,
    Contract,
    FleetTeam,
    InstanceData,
    Line,
    LocationSupply,
    Parameters,
    Sector,
    Station,
)


class CsvSchemaError(ValueError):
    """Raised when an uploaded CSV does not match the published schema."""


# --------------------------------------------------------------------------- #
# primitives                                                                   #
# --------------------------------------------------------------------------- #


def _s(row: dict, key: str, default: str = "") -> str:
    v = row.get(key)
    if v is None:
        return default
    v = str(v).strip()
    return v if v else default


def _i(row: dict, key: str, default: int = 0) -> int:
    v = _s(row, key)
    if not v:
        return default
    try:
        value = float(v)
        if not math.isfinite(value) or not value.is_integer():
            raise ValueError()
        return int(value)
    except ValueError:
        raise CsvSchemaError(f"Invalid integer for {key}: {v!r}")


def _f(row: dict, key: str, default: float = 0.0) -> float:
    v = _s(row, key)
    if not v:
        return default
    try:
        value = float(v)
        if not math.isfinite(value):
            raise ValueError()
        return value
    except ValueError:
        raise CsvSchemaError(f"Invalid number for {key}: {v!r}")


_DATE_FORMATS = ("%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y", "%d-%b-%Y", "%Y/%m/%d")


def _d(row: dict, key: str) -> Optional[date]:
    v = _s(row, key)
    if not v:
        return None
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(v, fmt).date()
        except ValueError:
            continue
    raise CsvSchemaError(f"Invalid date for {key}: {v!r}")


def _opt(row: dict, key: str) -> Optional[str]:
    v = _s(row, key)
    return v or None


def _of(row: dict, key: str) -> Optional[float]:
    """A number that is allowed to be blank — blank means 'not supplied'."""
    v = _s(row, key)
    if not v:
        return None
    return _f(row, key)


# --------------------------------------------------------------------------- #
# header validation                                                            #
# --------------------------------------------------------------------------- #


def read_rows(name: str, raw: bytes | str) -> List[dict]:
    """Decode + parse a CSV, enforcing the published header for `name`."""
    text = raw.decode("utf-8-sig") if isinstance(raw, bytes) else raw
    reader = csv.DictReader(io.StringIO(text))
    headers = [h.strip() for h in (reader.fieldnames or [])]
    validate_headers(name, headers)
    if len(headers) != len(set(headers)):
        raise CsvSchemaError(f"{name}: duplicate column names")
    rows: List[dict] = []
    for r in reader:
        if None in r or any(v is None for v in r.values()):
            raise CsvSchemaError(f"{name} row {reader.line_num}: incorrect number of fields")
        clean = {(k or "").strip(): v for k, v in r.items()}
        identifier = ALL_HEADERS[name][0]
        if not _s(clean, identifier):
            raise CsvSchemaError(f"{name} row {reader.line_num}: missing {identifier}")
        numeric = {"seq", "is_interchange", "is_shared", "supply_capacity", "up_to_buffer_sectors",
                   "opposite_bound_required", "contract_priority", "number_of_workfronts",
                   "number_of_maximum_access_per_week", "total_accesses", "activity_priority"}
        for key in numeric.intersection(ALL_HEADERS[name]):
            if not _s(clean, key):
                raise CsvSchemaError(f"{name} row {reader.line_num}: missing {key}")
        rows.append(clean)
    return rows


def validate_headers(name: str, headers: Sequence[str]) -> None:
    required = ALL_HEADERS.get(name)
    if required is None:
        known = ", ".join(ALL_HEADERS)
        raise CsvSchemaError(f"{name} is not one of the expected instance files ({known}).")
    missing = [h for h in required if h not in headers]
    if missing:
        raise CsvSchemaError(
            f"{name} is of wrong format. Missing column(s): {', '.join(missing)}. "
            f"Required headers: {', '.join(required)}"
        )


# --------------------------------------------------------------------------- #
# instance assembly                                                            #
# --------------------------------------------------------------------------- #


def parse_instance(files: Dict[str, bytes | str]) -> InstanceData:
    """
    files: {"01_LINES.csv": <bytes>, ...} — the 8 REQUIRED_HEADERS keys are
    mandatory; anything in OPTIONAL_HEADERS (09_FLEET_DATA.csv) is used when
    present and ignored when absent.
    """
    missing = [n for n in REQUIRED_HEADERS if n not in files]
    if missing:
        raise CsvSchemaError(f"Missing instance file(s): {', '.join(sorted(missing))}")

    lines = [
        Line(line_code=_s(r, "line_code"), line_name=_s(r, "line_name"))
        for r in read_rows("01_LINES.csv", files["01_LINES.csv"])
        if _s(r, "line_code")
    ]

    stations = [
        Station(
            station_id=_s(r, "station_id"),
            line_code=_s(r, "line_code"),
            seq=_i(r, "seq"),
            is_interchange=_i(r, "is_interchange"),
        )
        for r in read_rows("02_STATIONS.csv", files["02_STATIONS.csv"])
        if _s(r, "station_id")
    ]

    sectors = [
        Sector(
            sector_id=_s(r, "sector_id"),
            line_code=_s(r, "line_code"),
            from_station_id=_s(r, "from_station_id"),
            to_station_id=_s(r, "to_station_id"),
            seq=_i(r, "seq"),
            is_shared=_i(r, "is_shared"),
        )
        for r in read_rows("03_SECTORS.csv", files["03_SECTORS.csv"])
        if _s(r, "sector_id")
    ]

    supply = [
        LocationSupply(
            location_id=_s(r, "location_id"),
            location_kind=_s(r, "location_kind"),
            line_code=_s(r, "line_code"),
            bound=_s(r, "bound"),
            supply_capacity=_i(r, "supply_capacity", 1),
        )
        for r in read_rows("04_LOCATION_SUPPLY.csv", files["04_LOCATION_SUPPLY.csv"])
        if _s(r, "location_id")
    ]

    buffers = [
        BufferRule(
            nature_of_works=_s(r, "nature_of_works"),
            up_to_buffer_sectors=_i(r, "up_to_buffer_sectors"),
            opposite_bound_required=_i(r, "opposite_bound_required"),
        )
        for r in read_rows("05_BUFFER_LOCATION.csv", files["05_BUFFER_LOCATION.csv"])
        if _s(r, "nature_of_works")
    ]

    kv = {
        _s(r, "key"): _s(r, "value")
        for r in read_rows("06_PARAMETERS.csv", files["06_PARAMETERS.csv"])
        if _s(r, "key")
    }
    horizon_start = None
    for fmt in _DATE_FORMATS:
        try:
            horizon_start = datetime.strptime(kv.get("horizon_start", ""), fmt).date()
            break
        except ValueError:
            continue
    if horizon_start is None:
        raise CsvSchemaError("06_PARAMETERS.csv is missing a valid 'horizon_start'.")
    parameters = Parameters(
        horizon_start=horizon_start,
        horizon_weeks=_i(kv, "horizon_weeks", 30),
        extra={k: v for k, v in kv.items() if k not in ("horizon_start", "horizon_weeks")},
    )

    contracts = [
        Contract(
            contract_number=_s(r, "contract_number"),
            contract_description=_s(r, "contract_description"),
            contract_award_date=_d(r, "contract_award_date"),
            activity_type=_s(r, "activity_type"),
            nature_of_activity=_s(r, "nature_of_activity"),
            contract_priority=_i(r, "contract_priority", 3),
            contract_completion_date=_d(r, "contract_completion_date"),
            planned_completion_date=_d(r, "planned_completion_date"),
            number_of_workfronts=_i(r, "number_of_workfronts", 1),
            access_type=_s(r, "access_type", "C").upper(),
            number_of_maximum_access_per_week=_i(r, "number_of_maximum_access_per_week", 3),
        )
        for r in read_rows("07_PROJECT_DETAILS.csv", files["07_PROJECT_DETAILS.csv"])
        if _s(r, "contract_number")
    ]

    activities = [
        Activity(
            activity_id=_s(r, "activity_id"),
            contract_number=_s(r, "contract_number"),
            activity_type=_s(r, "activity_type"),
            start_location_id=_s(r, "start_location_id"),
            end_location_id=_s(r, "end_location_id") or _s(r, "start_location_id"),
            total_accesses=_f(r, "total_accesses", 1.0),
            planned_start_date=_d(r, "planned_start_date"),
            predecessor_activity_id=_opt(r, "predecessor_activity_id"),
            activity_priority=_i(r, "activity_priority", 2),
        )
        for r in read_rows("08_ACTIVITY_DETAILS.csv", files["08_ACTIVITY_DETAILS.csv"])
        if _s(r, "activity_id")
    ]

    fleet = parse_fleet(files.get("09_FLEET_DATA.csv"))

    instance = InstanceData(
        lines=lines,
        stations=stations,
        sectors=sectors,
        supply=supply,
        buffers=buffers,
        parameters=parameters,
        contracts=contracts,
        activities=activities,
        fleet=fleet,
    )
    validate_instance(instance)
    return instance


def parse_fleet(raw: bytes | str | None) -> List[FleetTeam]:
    """09_FLEET_DATA.csv -> teams. `None` (file not supplied) yields an empty fleet."""
    if raw is None:
        return []
    return [
        FleetTeam(
            team_id=_s(r, "team_id"),
            base_station_id=_s(r, "base_station_id"),
            coord_x=_of(r, "coord_x"),
            coord_y=_of(r, "coord_y"),
            activity_type_specialty=_s(r, "activity_type_specialty"),
            expertise_tier=_s(r, "expertise_tier"),
        )
        for r in read_rows("09_FLEET_DATA.csv", raw)
        if _s(r, "team_id")
    ]


def load_instance_from_dir(directory: str) -> InstanceData:
    """Load the bundled reference instance from `backend/data/`."""
    import pathlib

    base = pathlib.Path(directory)
    files: Dict[str, bytes] = {}
    for name in REQUIRED_HEADERS:
        p = base / name
        if not p.exists():
            raise CsvSchemaError(f"Bundled instance is missing {name} in {directory}")
        files[name] = p.read_bytes()
    for name in OPTIONAL_HEADERS:
        p = base / name
        if p.exists():
            files[name] = p.read_bytes()
    return parse_instance(files)


def validate_instance(data: InstanceData) -> None:
    """Reject malformed references before they can remove workload or safety rules."""
    from .network import Network, parse_location, topological_order

    def unique(values, label):
        if len(values) != len(set(values)):
            raise CsvSchemaError(f"Duplicate {label}")

    unique([a.activity_id for a in data.activities], "activity_id")
    unique([c.contract_number for c in data.contracts], "contract_number")
    unique([s.location_id for s in data.supply], "location_id")
    unique([l.line_code for l in data.lines], "line_code")
    unique([(s.line_code, s.station_id) for s in data.stations], "station per line")
    unique([(s.line_code, s.seq) for s in data.stations], "station sequence per line")
    unique([s.sector_id for s in data.sectors], "sector_id")
    unique([b.nature_of_works.lower().strip() for b in data.buffers], "buffer rule")
    unique([t.team_id for t in data.fleet], "team_id")
    if not all((data.lines, data.stations, data.sectors, data.supply, data.buffers, data.contracts, data.activities)):
        raise CsvSchemaError("Instance tables must not be empty")
    if data.parameters.horizon_weeks < 1:
        raise CsvSchemaError("horizon_weeks must be positive")
    lines = {l.line_code for l in data.lines}
    if any(s.line_code not in lines for s in data.stations + data.sectors):
        raise CsvSchemaError("Unknown line in stations or sectors")
    net = Network.build(data)
    for line, stations in net.stations_by_line.items():
        expected = [f"{a}_{b}" for a, b in zip(stations, stations[1:])]
        if net.sector_keys_by_line.get(line) != expected:
            raise CsvSchemaError(f"{line}: sectors must form the ordered station chain")
    for row in data.supply:
        r = parse_location(row.location_id)
        if (not r or r.bound not in ("EB", "WB") or r.line != row.line_code
                or r.bound != row.bound or row.supply_capacity < 0
                or (r.kind == "SEC" and (r.line, r.key) not in net.sector_index)
                or (r.kind == "PLAT" and (r.line, r.key) not in net.station_index)):
            raise CsvSchemaError(f"Invalid supply location: {row.location_id}")
    required_locations = {
        f"{kind}:{line}:{key}:{bound}"
        for line in net.stations_by_line
        for kind, keys in (("SEC", net.sector_keys_by_line[line]), ("PLAT", net.stations_by_line[line]))
        for key in keys for bound in ("EB", "WB")
    }
    if required_locations - net.known_locations:
        raise CsvSchemaError("LOCATION_SUPPLY must declare every tunnel/platform on both bounds")
    for b in data.buffers:
        if b.up_to_buffer_sectors < 0 or b.opposite_bound_required not in (0, 1):
            raise CsvSchemaError(f"Invalid buffer rule: {b.nature_of_works}")
    contracts, activities = data.contract_map(), data.activity_map()
    for c in data.contracts:
        if (c.contract_priority not in (1, 2, 3) or c.access_type not in ("PM", "PC", "C")
                or c.number_of_workfronts < 1 or c.number_of_maximum_access_per_week < 1
                or c.planned_completion_date is None or c.nature_of_activity.strip().lower() not in data.buffer_map()):
            raise CsvSchemaError(f"Invalid contract settings or missing buffer rule: {c.contract_number}")
    for a in data.activities:
        if (a.contract_number not in contracts or a.activity_priority not in (1, 2, 3)
                or not math.isfinite(a.total_accesses) or a.total_accesses <= 0
                or a.planned_start_date is None):
            raise CsvSchemaError(f"Invalid activity settings: {a.activity_id}")
        if a.predecessor_activity_id and a.predecessor_activity_id not in activities:
            raise CsvSchemaError(f"{a.activity_id}: unknown predecessor {a.predecessor_activity_id}")
        start, end = parse_location(a.start_location_id), parse_location(a.end_location_id)
        if (a.start_location_id not in net.supply or a.end_location_id not in net.supply
                or not start or not end or start.line != end.line or start.bound != end.bound):
            raise CsvSchemaError(f"{a.activity_id}: endpoints must be known locations on one line and bound")
        missing = set(net.expand_path(a.start_location_id, a.end_location_id)) - net.known_locations
        if missing:
            raise CsvSchemaError(f"{a.activity_id}: missing supply for {sorted(missing)}")
    # 09_FLEET_DATA.csv is optional, but a team that is present must be placeable:
    # it needs either explicit coordinates or a base station the network knows.
    known_stations = {s.station_id for s in data.stations}
    for t in data.fleet:
        has_coords = t.coord_x is not None and t.coord_y is not None
        if not has_coords and t.base_station_id not in known_stations:
            raise CsvSchemaError(
                f"{t.team_id}: base_station_id '{t.base_station_id}' is not a known station "
                f"and no coord_x/coord_y were supplied"
            )
    try:
        topological_order(data)
    except ValueError as exc:
        raise CsvSchemaError(str(exc)) from exc
