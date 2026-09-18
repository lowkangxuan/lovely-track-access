"""
Pydantic models + CSV schema registry for the 8 instance files and the 3 output files.

The REQUIRED_HEADERS map is the single source of truth for validation and is
served to the frontend at GET /api/schemas so the browser-side validator and the
backend can never drift apart.
"""

from __future__ import annotations

from datetime import date
from typing import Dict, List, Optional

from pydantic import BaseModel, Field

# --------------------------------------------------------------------------- #
# Canonical CSV headers                                                        #
# --------------------------------------------------------------------------- #

REQUIRED_HEADERS: Dict[str, List[str]] = {
    "01_LINES.csv": ["line_code", "line_name"],
    "02_STATIONS.csv": ["station_id", "line_code", "seq", "is_interchange"],
    "03_SECTORS.csv": [
        "sector_id",
        "line_code",
        "from_station_id",
        "to_station_id",
        "seq",
        "is_shared",
    ],
    "04_LOCATION_SUPPLY.csv": [
        "location_id",
        "location_kind",
        "line_code",
        "bound",
        "supply_capacity",
    ],
    "05_BUFFER_LOCATION.csv": [
        "nature_of_works",
        "up_to_buffer_sectors",
        "opposite_bound_required",
    ],
    "06_PARAMETERS.csv": ["key", "value"],
    "07_PROJECT_DETAILS.csv": [
        "contract_number",
        "contract_description",
        "contract_award_date",
        "activity_type",
        "nature_of_activity",
        "contract_priority",
        "contract_completion_date",
        "planned_completion_date",
        "number_of_workfronts",
        "access_type",
        "number_of_maximum_access_per_week",
    ],
    "08_ACTIVITY_DETAILS.csv": [
        "activity_id",
        "contract_number",
        "activity_type",
        "start_location_id",
        "end_location_id",
        "total_accesses",
        "planned_start_date",
        "predecessor_activity_id",
        "activity_priority",
    ],
}

OUTPUT_HEADERS: Dict[str, List[str]] = {
    "SCHEDULE_ACCESS.csv": ["activity_id", "access_seq", "week", "eclo", "access_night"],
    "SCHEDULE_OCCUPANCY.csv": ["activity_id", "week", "location_id", "co_share_group"],
    "RESULTS.csv": [
        "scenario",
        "contract_number",
        "simulated_completion_date",
        "overrun_days",
    ],
}

SCENARIOS = {
    "A": "Strict Supply, Flexible Schedule",
    "B": "Strict Schedule, Flexible Supply",
    "C": "Elastic Supply, Flexible Schedule",
}


# --------------------------------------------------------------------------- #
# Instance models                                                              #
# --------------------------------------------------------------------------- #


class Line(BaseModel):
    line_code: str
    line_name: str


class Station(BaseModel):
    station_id: str
    line_code: str
    seq: int
    is_interchange: int = 0


class Sector(BaseModel):
    sector_id: str
    line_code: str
    from_station_id: str
    to_station_id: str
    seq: int
    is_shared: int = 0


class LocationSupply(BaseModel):
    location_id: str
    location_kind: str
    line_code: str
    bound: str
    supply_capacity: int


class BufferRule(BaseModel):
    nature_of_works: str
    up_to_buffer_sectors: int
    opposite_bound_required: int


class Contract(BaseModel):
    contract_number: str
    contract_description: str = ""
    contract_award_date: Optional[date] = None
    activity_type: str = ""
    nature_of_activity: str = ""
    contract_priority: int = 3
    contract_completion_date: Optional[date] = None
    planned_completion_date: Optional[date] = None
    number_of_workfronts: int = 1
    access_type: str = "C"
    number_of_maximum_access_per_week: int = 3


class Activity(BaseModel):
    activity_id: str
    contract_number: str
    activity_type: str = ""
    start_location_id: str
    end_location_id: str
    total_accesses: float = 1.0
    planned_start_date: Optional[date] = None
    predecessor_activity_id: Optional[str] = None
    activity_priority: int = 2


class Parameters(BaseModel):
    horizon_start: date
    horizon_weeks: int = 30
    extra: Dict[str, str] = Field(default_factory=dict)


class InstanceData(BaseModel):
    """Everything parsed out of the 8 instance CSVs. This is what solvers receive."""

    lines: List[Line]
    stations: List[Station]
    sectors: List[Sector]
    supply: List[LocationSupply]
    buffers: List[BufferRule]
    parameters: Parameters
    contracts: List[Contract]
    activities: List[Activity]

    # convenience lookups -------------------------------------------------- #
    def contract_map(self) -> Dict[str, Contract]:
        return {c.contract_number: c for c in self.contracts}

    def activity_map(self) -> Dict[str, Activity]:
        return {a.activity_id: a for a in self.activities}

    def supply_map(self) -> Dict[str, int]:
        return {s.location_id: s.supply_capacity for s in self.supply}

    def buffer_map(self) -> Dict[str, BufferRule]:
        return {b.nature_of_works.strip().lower(): b for b in self.buffers}


# --------------------------------------------------------------------------- #
# Submission / output models                                                   #
# --------------------------------------------------------------------------- #


class AccessRow(BaseModel):
    activity_id: str
    access_seq: int
    week: int
    eclo: int = 0
    access_night: int = 1


class OccupancyRow(BaseModel):
    activity_id: str
    week: int
    location_id: str
    co_share_group: str


class ResultRow(BaseModel):
    scenario: str
    contract_number: str
    simulated_completion_date: str
    overrun_days: int


class SoftScores(BaseModel):
    scenario: str
    overrun_days_total: int = 0
    contracts_overrunning: int = 0
    earliness_days_total: int = 0
    excess_access_nights_total: int = 0
    eclo_nights_total: int = 0
    priority_overrun: Dict[str, int] = Field(default_factory=dict)
    priority_weighted_score: float = 0.0
    objective_score: Optional[float] = None
    formula_version: Optional[str] = None


class Violation(BaseModel):
    rule: str
    severity: str = "hard"
    detail: str


class SolveOutput(BaseModel):
    """The contract every scenario solver must satisfy."""

    scenario: str
    feasible: bool = True
    hard_violations: List[Violation] = Field(default_factory=list)
    soft_scores: SoftScores
    detail: Dict[str, object] = Field(default_factory=dict)

    schedule_access: List[AccessRow] = Field(default_factory=list)
    schedule_occupancy: List[OccupancyRow] = Field(default_factory=list)
    results: List[ResultRow] = Field(default_factory=list)
