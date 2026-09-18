"""
CSV -> InstanceData parsing, plus header validation shared with the frontend.

Every parser is defensive: unknown extra columns are ignored, blanks become
None, and a bad header raises CsvSchemaError with a message the UI can show
verbatim.
"""

from __future__ import annotations

import csv
import io
from datetime import date, datetime
from typing import Dict, List, Optional, Sequence

from .schemas import (
    REQUIRED_HEADERS,
    Activity,
    BufferRule,
    Contract,
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
        return int(float(v))
    except ValueError:
        return default


def _f(row: dict, key: str, default: float = 0.0) -> float:
    v = _s(row, key)
    if not v:
        return default
    try:
        return float(v)
    except ValueError:
        return default


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
    return None


def _opt(row: dict, key: str) -> Optional[str]:
    v = _s(row, key)
    return v or None


# --------------------------------------------------------------------------- #
# header validation                                                            #
# --------------------------------------------------------------------------- #


def read_rows(name: str, raw: bytes | str) -> List[dict]:
    """Decode + parse a CSV, enforcing the published header for `name`."""
    text = raw.decode("utf-8-sig") if isinstance(raw, bytes) else raw
    reader = csv.DictReader(io.StringIO(text))
    headers = [h.strip() for h in (reader.fieldnames or [])]
    validate_headers(name, headers)
    rows: List[dict] = []
    for r in reader:
        rows.append({(k or "").strip(): v for k, v in r.items()})
    return rows


def validate_headers(name: str, headers: Sequence[str]) -> None:
    required = REQUIRED_HEADERS.get(name)
    if required is None:
        raise CsvSchemaError(f"{name} is not one of the 8 expected instance files.")
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
    files: {"01_LINES.csv": <bytes>, ...} — all 8 keys required.
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
        horizon_weeks=int(float(kv.get("horizon_weeks", "30") or 30)),
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
            number_of_workfronts=max(1, _i(r, "number_of_workfronts", 1)),
            access_type=_s(r, "access_type", "C").upper(),
            number_of_maximum_access_per_week=max(
                1, _i(r, "number_of_maximum_access_per_week", 3)
            ),
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
            total_accesses=max(0.0, _f(r, "total_accesses", 1.0)),
            planned_start_date=_d(r, "planned_start_date"),
            predecessor_activity_id=_opt(r, "predecessor_activity_id"),
            activity_priority=_i(r, "activity_priority", 2),
        )
        for r in read_rows("08_ACTIVITY_DETAILS.csv", files["08_ACTIVITY_DETAILS.csv"])
        if _s(r, "activity_id")
    ]

    return InstanceData(
        lines=lines,
        stations=stations,
        sectors=sectors,
        supply=supply,
        buffers=buffers,
        parameters=parameters,
        contracts=contracts,
        activities=activities,
    )


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
    return parse_instance(files)
