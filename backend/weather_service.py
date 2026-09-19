"""
Open-Meteo daily weather for the planning horizon, with a disk cache.

Horizon dates inside Open-Meteo's forecast window (up to 16 days ahead, 92
days back) come from the Forecast API. A horizon further out — the bundled
instance starts 2027-01-04 — has no forecast, so the same calendar dates from
the most recent fully archived year stand in as an *analogue year* via the
ERA5 archive API. `WeatherOutlook.analogue_year` says when that happened.

Location comes from optional `weather_latitude` / `weather_longitude` keys in
06_PARAMETERS.csv and defaults to Singapore.
"""

from __future__ import annotations

import json
import os
import pathlib
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, timedelta
from typing import Dict, List, Optional, Tuple

import certifi

from solver import WeatherOutlook, make_day

FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
DAILY_FIELDS = "weather_code,precipitation_sum"
DEFAULT_LATITUDE, DEFAULT_LONGITUDE = 1.3521, 103.8198   # Singapore
FORECAST_DAYS_AHEAD = 16
FORECAST_DAYS_BACK = 92
ARCHIVE_LAG_DAYS = 7          # ERA5 trails real time by a few days
CACHE_TTL_SECONDS = 12 * 3600
HTTP_TIMEOUT_SECONDS = 20


class WeatherUnavailable(RuntimeError):
    """Raised when neither the API nor the cache can supply the horizon."""


def coordinates(parameters_extra: Dict[str, str]) -> Tuple[float, float]:
    try:
        return (float(parameters_extra.get("weather_latitude", DEFAULT_LATITUDE)),
                float(parameters_extra.get("weather_longitude", DEFAULT_LONGITUDE)))
    except (TypeError, ValueError):
        return DEFAULT_LATITUDE, DEFAULT_LONGITUDE


def _shift_year(d: date, years: int) -> date:
    try:
        return d.replace(year=d.year + years)
    except ValueError:              # 29 Feb into a non-leap year
        return d.replace(year=d.year + years, day=28)


def _plan(start: date, end: date, today: date) -> Tuple[str, date, date, int]:
    """(api_url, query_start, query_end, year_shift) — shift is 0 for a live forecast."""
    if start >= today - timedelta(days=FORECAST_DAYS_BACK) and end <= today + timedelta(days=FORECAST_DAYS_AHEAD):
        return FORECAST_URL, start, end, 0
    latest = today - timedelta(days=ARCHIVE_LAG_DAYS)
    shift = 0
    while _shift_year(end, -shift) > latest:
        shift += 1
    return ARCHIVE_URL, _shift_year(start, -shift), _shift_year(end, -shift), shift


def _http_get_json(url: str, params: Dict[str, object]) -> dict:
    query = urllib.parse.urlencode(params)
    req = urllib.request.Request(f"{url}?{query}", headers={"User-Agent": "track-access-scheduler/1.0"})
    # Some Python installations have no default CA bundle. Add certifi's roots
    # while retaining system/custom trust and certificate/hostname verification.
    context = ssl.create_default_context()
    context.load_verify_locations(cafile=certifi.where())
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SECONDS, context=context) as res:
        return json.loads(res.read().decode("utf-8"))


def fetch_daily(url: str, latitude: float, longitude: float, start: date, end: date) -> dict:
    """Raw Open-Meteo daily payload. Separated so tests can stub it."""
    return _http_get_json(url, {
        "latitude": latitude, "longitude": longitude,
        "start_date": start.isoformat(), "end_date": end.isoformat(),
        "daily": DAILY_FIELDS, "timezone": "auto",
    })


def _cache_path(cache_dir: pathlib.Path, latitude: float, longitude: float, start: date, end: date) -> pathlib.Path:
    return cache_dir / f"weather_{latitude:.4f}_{longitude:.4f}_{start.isoformat()}_{end.isoformat()}.json"


def fetch_outlook(
    latitude: float,
    longitude: float,
    start: date,
    end: date,
    cache_dir: Optional[pathlib.Path] = None,
    today: Optional[date] = None,
) -> WeatherOutlook:
    """Daily outlook for [start, end]; cached on disk, analogue-year fallback beyond the forecast window."""
    today = today or date.today()
    cache = _cache_path(cache_dir, latitude, longitude, start, end) if cache_dir else None
    if cache and cache.exists():
        try:
            saved = json.loads(cache.read_text(encoding="utf-8"))
            if time.time() - saved.get("fetched_at", 0) < CACHE_TTL_SECONDS:
                return WeatherOutlook.model_validate(saved["outlook"])
        except (ValueError, KeyError):
            pass

    url, q_start, q_end, shift = _plan(start, end, today)
    try:
        raw = fetch_daily(url, latitude, longitude, q_start, q_end)
    except (urllib.error.URLError, OSError, ValueError) as exc:
        if cache and cache.exists():          # stale cache beats no data
            try:
                return WeatherOutlook.model_validate(json.loads(cache.read_text(encoding="utf-8"))["outlook"])
            except (ValueError, KeyError):
                pass
        raise WeatherUnavailable(f"Open-Meteo unreachable ({exc}); no cached weather for this horizon.") from exc

    daily = raw.get("daily") or {}
    dates = daily.get("time") or []
    codes = daily.get("weather_code") or [None] * len(dates)
    rain = daily.get("precipitation_sum") or [0.0] * len(dates)
    if not dates:
        raise WeatherUnavailable(f"Open-Meteo returned no daily data: {raw.get('reason', 'empty response')}")

    days = []
    for iso, code, mm in zip(dates, codes, rain):
        d = _shift_year(date.fromisoformat(iso), shift)
        if start <= d <= end:
            days.append(make_day(d, None if code is None else int(code), float(mm or 0.0)))

    outlook = WeatherOutlook(
        days=days,
        source="open-meteo-forecast" if shift == 0 else f"open-meteo-archive (analogue year {q_start.year})",
        latitude=latitude,
        longitude=longitude,
        analogue_year=None if shift == 0 else q_start.year,
    )
    if cache:
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps({"fetched_at": time.time(), "outlook": outlook.model_dump(mode="json")}),
                         encoding="utf-8")
    return outlook
