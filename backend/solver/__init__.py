"""Railway Track Access Scheduler — solver package."""

from .allocation import allocate_teams, station_coordinates
from .loader import CsvSchemaError, load_instance_from_dir, parse_fleet, parse_instance, validate_headers
from .network import Calendar, Network, build_activity_plans
from .registry import get_solver, register, registered, solve_scenario
from .weather import WeatherDay, WeatherOutlook, classify_sectors, horizon_dates, make_day
from .schemas import (
    ALL_HEADERS,
    OPTIONAL_HEADERS,
    OUTPUT_HEADERS,
    REQUIRED_HEADERS,
    SCENARIOS,
    AccessRow,
    Activity,
    Contract,
    FleetTeam,
    InstanceData,
    OccupancyRow,
    ResultRow,
    SoftScores,
    SolveOutput,
    Violation,
)

__all__ = [
    "CsvSchemaError",
    "parse_instance",
    "parse_fleet",
    "allocate_teams",
    "station_coordinates",
    "load_instance_from_dir",
    "validate_headers",
    "Calendar",
    "Network",
    "build_activity_plans",
    "solve_scenario",
    "register",
    "get_solver",
    "registered",
    "REQUIRED_HEADERS",
    "OPTIONAL_HEADERS",
    "ALL_HEADERS",
    "OUTPUT_HEADERS",
    "SCENARIOS",
    "InstanceData",
    "SolveOutput",
    "SoftScores",
    "AccessRow",
    "OccupancyRow",
    "ResultRow",
    "Violation",
    "Activity",
    "Contract",
    "FleetTeam",
    "WeatherDay",
    "WeatherOutlook",
    "classify_sectors",
    "horizon_dates",
    "make_day",
]
