"""Railway Track Access Scheduler — solver package."""

from .loader import CsvSchemaError, load_instance_from_dir, parse_instance, validate_headers
from .network import Calendar, Network, build_activity_plans
from .registry import get_solver, register, registered, solve_scenario
from .weather import WeatherDay, WeatherOutlook, classify_sectors, horizon_dates, make_day
from .schemas import (
    OUTPUT_HEADERS,
    REQUIRED_HEADERS,
    SCENARIOS,
    AccessRow,
    Activity,
    Contract,
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
    "WeatherDay",
    "WeatherOutlook",
    "classify_sectors",
    "horizon_dates",
    "make_day",
]
