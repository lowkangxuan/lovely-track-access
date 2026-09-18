"""
Weather-aware scheduling — pure logic, no I/O.

* Open-line track sectors (`SEC:` locations) are split deterministically into
  "tunnel" (60 %) and "viaduct" (40 %). Station platforms (`PLAT:`) are
  sheltered and never affected.
* A daily outlook classifies each horizon day as sun / rain / heavy_rain /
  thunderstorm; heavy rain and thunderstorms are *severe*.
* Every severe day removes one possession night from each viaduct sector for
  that week (the solver books nights per location-week, not per calendar day),
  so `supply_capacity` shrinks to `max(0, capacity - severe_days)`. Tunnels and
  platforms keep their full supply. No new score terms: the forced shifts and
  delays flow through the standard Scenario A / B / C objective formulas.
"""

from __future__ import annotations

import random
from datetime import date, timedelta
from typing import Dict, Iterable, List, Optional, Set, Tuple

from pydantic import BaseModel, Field

TUNNEL_SHARE = 0.6
DEFAULT_SECTOR_SEED = 42
SECTOR_SEED_PARAMETER = "sector_kind_seed"  # optional key in 06_PARAMETERS.csv

# WMO weather interpretation codes as served by Open-Meteo.
THUNDERSTORM_CODES = {95, 96, 99}
HEAVY_RAIN_CODES = {65, 67, 82}
RAIN_CODES = {51, 53, 55, 56, 57, 61, 63, 66, 80, 81}
HEAVY_RAIN_MM = 25.0   # precipitation_sum at/above this is severe regardless of code
RAIN_MM = 1.0


class WeatherDay(BaseModel):
    date: date
    weather_code: Optional[int] = None
    precipitation_mm: float = 0.0
    condition: str = "sun"          # sun | rain | heavy_rain | thunderstorm
    severe: bool = False


class WeatherOutlook(BaseModel):
    """Daily conditions across the planning horizon, plus where they came from."""

    days: List[WeatherDay] = Field(default_factory=list)
    source: str = ""
    latitude: float = 0.0
    longitude: float = 0.0
    analogue_year: Optional[int] = None   # set when a past year stood in for the horizon

    def severe_dates(self) -> Set[date]:
        return {d.date for d in self.days if d.severe}


def classify_condition(weather_code: Optional[int], precipitation_mm: float) -> Tuple[str, bool]:
    """(condition, severe) for one day."""
    code = weather_code if weather_code is not None else -1
    mm = precipitation_mm or 0.0
    if code in THUNDERSTORM_CODES:
        return "thunderstorm", True
    if code in HEAVY_RAIN_CODES or mm >= HEAVY_RAIN_MM:
        return "heavy_rain", True
    if code in RAIN_CODES or mm >= RAIN_MM:
        return "rain", False
    return "sun", False


def make_day(day: date, weather_code: Optional[int], precipitation_mm: float) -> WeatherDay:
    condition, severe = classify_condition(weather_code, precipitation_mm)
    return WeatherDay(date=day, weather_code=weather_code, precipitation_mm=round(precipitation_mm or 0.0, 1),
                      condition=condition, severe=severe)


def classify_sectors(sector_ids: Iterable[str], seed: int = DEFAULT_SECTOR_SEED) -> Dict[str, str]:
    """
    Deterministic 60/40 tunnel/viaduct split of bound-less sector ids
    (`SEC:ALP:S01_S02`). Same ids + same seed always give the same answer.
    """
    ids = sorted(set(sector_ids))
    rng = random.Random(seed)
    rng.shuffle(ids)
    tunnels = round(len(ids) * TUNNEL_SHARE)
    return {sid: ("tunnel" if i < tunnels else "viaduct") for i, sid in enumerate(ids)}


def sector_seed(parameters_extra: Dict[str, str]) -> int:
    try:
        return int(parameters_extra.get(SECTOR_SEED_PARAMETER, DEFAULT_SECTOR_SEED))
    except (TypeError, ValueError):
        return DEFAULT_SECTOR_SEED


def severe_nights_by_week(outlook: WeatherOutlook, horizon_start: date) -> Dict[int, int]:
    """Week number (1-based from `horizon_start`) -> number of severe days in that week."""
    counts: Dict[int, int] = {}
    for day in outlook.days:
        if not day.severe or day.date < horizon_start:
            continue
        week = (day.date - horizon_start).days // 7 + 1
        counts[week] = counts.get(week, 0) + 1
    return counts


def horizon_dates(horizon_start: date, horizon_weeks: int) -> Tuple[date, date]:
    return horizon_start, horizon_start + timedelta(days=horizon_weeks * 7 - 1)
