"""
Railway Track Access Scheduler — FastAPI service.

Run:
    pip install -r requirements.txt
    uvicorn main:app --reload --port 8000

Endpoints
---------
GET  /api/health          liveness + which solver is registered per scenario
GET  /api/schemas         the 8 required CSV headers (the UI validates against this)
GET  /api/schedule        baseline schedule from the bundled reference instance
POST /api/reschedule      multipart: 8 instance CSVs + `scenario` -> full schedule (a preview)
POST /api/schedule/activate  {run_id} -> promote a previewed run to the active schedule
GET  /api/schedule/active    the active schedule, 204 until one has been activated
GET  /api/download/{scenario}/{file}   SCHEDULE_ACCESS | SCHEDULE_OCCUPANCY | RESULTS
"""

from __future__ import annotations

import csv
import io
import pathlib
import time
import uuid
from threading import Lock
from datetime import date
from typing import Dict, List, Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from solver import (
    OUTPUT_HEADERS,
    REQUIRED_HEADERS,
    SCENARIOS,
    Calendar,
    CsvSchemaError,
    InstanceData,
    SolveOutput,
    load_instance_from_dir,
    parse_instance,
    registered,
    solve_scenario,
)
from solver.network import Network, build_activity_plans

DATA_DIR = pathlib.Path(__file__).parent / "data"

app = FastAPI(
    title="Railway Track Access Scheduler",
    version="1.0.0",
    description="Possession scheduling for the dual-line network (Line Alpha & Line Beta).",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# in-memory store of the most recent solve per scenario, for CSV download
_LAST_RUN: Dict[str, dict] = {}
# run_id -> {"scenario", "csv": {file: rows}, "view": dashboard view-model}
_RUNS: Dict[str, dict] = {}
_ACTIVE_RUN: Optional[str] = None  # run_id promoted via POST /api/schedule/activate
_RUN_LOCK = Lock()
_MAX_RUNS = 100


# --------------------------------------------------------------------------- #
# view-model: flatten the solve into the rows the dashboard renders            #
# --------------------------------------------------------------------------- #


def build_view_model(data: InstanceData, out: SolveOutput) -> dict:
    """
    One row per (activity, access) enriched with everything the card + detail
    modal shows, so the frontend never has to re-join CSVs itself.
    """
    cal = Calendar(data.parameters.horizon_start, data.parameters.horizon_weeks)
    net = Network.build(data)
    plans = build_activity_plans(data, net, cal)
    contracts = data.contract_map()
    acts = data.activity_map()

    occ_by_key: Dict[tuple, List[dict]] = {}
    for row in out.schedule_occupancy:
        occ_by_key.setdefault((row.activity_id, row.week), []).append(
            {"location_id": row.location_id, "co_share_group": row.co_share_group}
        )

    accesses_by_activity: Dict[str, list] = {}
    for row in out.schedule_access:
        accesses_by_activity.setdefault(row.activity_id, []).append(row)

    tasks: List[dict] = []
    for activity_id, rows in accesses_by_activity.items():
        act = acts.get(activity_id)
        if act is None:
            continue
        contract = contracts.get(act.contract_number)
        plan = plans.get(activity_id)
        rows = sorted(rows, key=lambda r: (r.week, r.access_seq))
        last_week = rows[-1].week
        finish = cal.sunday_of(last_week)
        planned_completion = contract.planned_completion_date if contract else None
        overrun_days = (
            max(0, (finish - planned_completion).days) if planned_completion else 0
        )

        for r in rows:
            occ = occ_by_key.get((activity_id, r.week), [])
            monday = cal.monday_of(r.week)
            tasks.append(
                {
                    "key": f"{activity_id}-{r.access_seq}",
                    "activity_id": activity_id,
                    "contract_number": act.contract_number,
                    "access_seq": r.access_seq,
                    "week": r.week,
                    "eclo": r.eclo,
                    "access_night": r.access_night,
                    "date": monday.isoformat(),
                    "week_end": cal.sunday_of(r.week).isoformat(),
                    "location_id": (occ[0]["location_id"] if occ else act.start_location_id),
                    "locations": [o["location_id"] for o in occ],
                    "co_share_group": (occ[0]["co_share_group"] if occ else "b1"),
                    "occupancy": occ,
                    # --- activity context (08_ACTIVITY_DETAILS.csv) ---------- #
                    "activity_description": f"{act.activity_type} · {act.start_location_id} → {act.end_location_id}",
                    "activity_type": act.activity_type,
                    "start_location_id": act.start_location_id,
                    "end_location_id": act.end_location_id,
                    "total_accesses": act.total_accesses,
                    "planned_start_date": act.planned_start_date.isoformat()
                    if act.planned_start_date
                    else None,
                    "activity_priority": act.activity_priority,
                    "predecessor_activity_id": act.predecessor_activity_id,
                    # --- contract context (07_PROJECT_DETAILS.csv) ----------- #
                    "contract_description": contract.contract_description if contract else "",
                    "contract_award_date": contract.contract_award_date.isoformat()
                    if contract and contract.contract_award_date
                    else None,
                    "nature_of_activity": contract.nature_of_activity if contract else "",
                    "contract_priority": contract.contract_priority if contract else 3,
                    "contract_completion_date": contract.contract_completion_date.isoformat()
                    if contract and contract.contract_completion_date
                    else None,
                    "planned_completion_date": planned_completion.isoformat()
                    if planned_completion
                    else None,
                    "number_of_workfronts": contract.number_of_workfronts if contract else 1,
                    "access_type": contract.access_type if contract else "C",
                    "number_of_maximum_access_per_week": contract.number_of_maximum_access_per_week
                    if contract
                    else 3,
                    # --- schedule metrics ------------------------------------ #
                    "access_nights_used": len(rows),
                    "activity_first_week": rows[0].week,
                    "activity_last_week": last_week,
                    "simulated_finish_date": finish.isoformat(),
                    "days_delayed": overrun_days,
                    "buffer_zone": plan.buffer_zone if plan else [],
                }
            )

    tasks.sort(key=lambda t: (t["week"], t["contract_number"], t["activity_id"], t["access_seq"]))

    return {
        "scenario": out.scenario,
        "scenario_label": SCENARIOS.get(out.scenario, out.scenario),
        "feasible": out.feasible,
        "hard_violations": [v.model_dump() for v in out.hard_violations],
        "soft_scores": out.soft_scores.model_dump(),
        # compact headline the editor's preview panel renders as-is
        "evaluation": {
            "feasible": out.feasible,
            "hard_violation_count": len(out.hard_violations),
            "access_nights_total": len(out.schedule_access),
            "overrun_days_total": out.soft_scores.overrun_days_total,
            "contracts_overrunning": out.soft_scores.contracts_overrunning,
            "eclo_nights_total": out.soft_scores.eclo_nights_total,
            "excess_access_nights_total": out.soft_scores.excess_access_nights_total,
            "objective_score": out.soft_scores.objective_score,
        },
        "detail": out.detail,
        "tasks": tasks,
        "network": {
            "lines": [line.model_dump() for line in data.lines],
            "stations": [station.model_dump() for station in data.stations],
            "sectors": [sector.model_dump() for sector in data.sectors],
        },
        "results": [r.model_dump() for r in out.results],
        "contracts": [
            {
                **c.model_dump(mode="json"),
            }
            for c in data.contracts
        ],
        "horizon": {
            "start": data.parameters.horizon_start.isoformat(),
            "weeks": data.parameters.horizon_weeks,
        },
        "counts": {
            "activities_total": len(data.activities),
            "activities_scheduled": len(accesses_by_activity),
            "access_nights": len(out.schedule_access),
            "contracts": len(data.contracts),
        },
    }


def _store_run(out: SolveOutput, view: dict) -> str:
    """Remember a solve (CSV rows + view-model) under a fresh run_id; the active run is never evicted."""
    csv_rows = {
        "SCHEDULE_ACCESS.csv": [r.model_dump() for r in out.schedule_access],
        "SCHEDULE_OCCUPANCY.csv": [r.model_dump() for r in out.schedule_occupancy],
        "RESULTS.csv": [r.model_dump() for r in out.results],
    }
    run_id = uuid.uuid4().hex
    view["run_id"] = run_id
    with _RUN_LOCK:
        _LAST_RUN[out.scenario] = csv_rows
        _RUNS[run_id] = {"scenario": out.scenario, "csv": csv_rows, "view": view}
        evictable = [k for k in _RUNS if k != _ACTIVE_RUN and k != run_id]
        while len(_RUNS) > _MAX_RUNS and evictable:
            del _RUNS[evictable.pop(0)]
    return run_id


def _solve_and_store(scenario: str, data: InstanceData, source: str) -> dict:
    started = time.perf_counter()
    out = solve_scenario(scenario, data)
    vm = build_view_model(data, out)
    vm["runtime_ms"] = round((time.perf_counter() - started) * 1000, 1)
    vm["source"] = source
    _store_run(out, vm)
    return vm


# --------------------------------------------------------------------------- #
# endpoints                                                                    #
# --------------------------------------------------------------------------- #


@app.get("/api/health")
def health() -> dict:
    return {
        "status": "ok",
        "scenarios": SCENARIOS,
        "solvers": registered(),
        "bundled_instance": DATA_DIR.exists(),
    }


@app.get("/api/schemas")
def schemas() -> dict:
    return {"instance": REQUIRED_HEADERS, "output": OUTPUT_HEADERS, "scenarios": SCENARIOS}


@app.get("/api/schedule")
def default_schedule(scenario: str = "A") -> dict:
    """Baseline run against the bundled reference instance — what the app boots with."""
    scenario = scenario.strip().upper()
    if scenario not in SCENARIOS:
        raise HTTPException(status_code=400, detail="scenario must be A, B or C")
    try:
        data = load_instance_from_dir(str(DATA_DIR))
    except CsvSchemaError as exc:
        raise HTTPException(status_code=503, detail=f"Bundled instance unavailable: {exc}")
    return _solve_and_store(scenario, data, "bundled-reference-instance")


class ActivateRequest(BaseModel):
    run_id: str


@app.post("/api/schedule/activate")
def activate_schedule(body: ActivateRequest) -> dict:
    """Promote a previewed run (from /api/reschedule or /api/schedule) to the active schedule."""
    global _ACTIVE_RUN
    with _RUN_LOCK:
        run = _RUNS.get(body.run_id)
        if run is None:
            raise HTTPException(status_code=404, detail=f"Unknown or expired run_id '{body.run_id}'")
        _ACTIVE_RUN = body.run_id
        _LAST_RUN[run["scenario"]] = run["csv"]
        return {**run["view"], "active": True}


@app.get("/api/schedule/active")
def active_schedule():
    """The schedule last implemented from the editor; 204 (no body) until one has been activated."""
    with _RUN_LOCK:
        run = _RUNS.get(_ACTIVE_RUN) if _ACTIVE_RUN else None
    if run is None:
        return Response(status_code=204)
    return {**run["view"], "active": True}


@app.post("/api/reschedule")
async def reschedule(
    scenario: str = Form("A"),
    files: List[UploadFile] = File(default=[]),
    # also accept the 8 files posted under their own field names
    lines: Optional[UploadFile] = File(default=None),
    stations: Optional[UploadFile] = File(default=None),
    sectors: Optional[UploadFile] = File(default=None),
    location_supply: Optional[UploadFile] = File(default=None),
    buffer_location: Optional[UploadFile] = File(default=None),
    parameters: Optional[UploadFile] = File(default=None),
    project_details: Optional[UploadFile] = File(default=None),
    activity_details: Optional[UploadFile] = File(default=None),
) -> dict:
    scenario = (scenario or "A").strip().upper()
    if scenario not in SCENARIOS:
        raise HTTPException(status_code=400, detail=f"scenario must be one of {list(SCENARIOS)}")

    uploads: List[UploadFile] = [f for f in files if f is not None]
    uploads += [
        f
        for f in (
            lines,
            stations,
            sectors,
            location_supply,
            buffer_location,
            parameters,
            project_details,
            activity_details,
        )
        if f is not None
    ]

    payload: Dict[str, bytes] = {}
    for upload in uploads:
        name = pathlib.Path(upload.filename or "").name
        if name not in REQUIRED_HEADERS:
            # tolerate prefixed/suffixed names, e.g. "instance_08_ACTIVITY_DETAILS.csv"
            match = next((k for k in REQUIRED_HEADERS if name.upper().endswith(k.upper())), None)
            if match is None:
                continue
            name = match
        if name in payload:
            raise HTTPException(status_code=422, detail={"message": f"Duplicate instance file: {name}"})
        payload[name] = await upload.read()

    missing = [n for n in REQUIRED_HEADERS if n not in payload]
    if missing:
        raise HTTPException(
            status_code=422,
            detail={
                "message": "Missing required instance file(s).",
                "missing": missing,
                "required": list(REQUIRED_HEADERS),
            },
        )

    try:
        data = parse_instance(payload)
    except CsvSchemaError as exc:
        raise HTTPException(status_code=422, detail={"message": str(exc)})
    except Exception as exc:  # pragma: no cover - defensive
        raise HTTPException(status_code=422, detail={"message": f"Could not parse instance: {exc}"})

    try:
        return await run_in_threadpool(_solve_and_store, scenario, data, "uploaded-instance")
    except Exception as exc:  # pragma: no cover - defensive
        raise HTTPException(status_code=500, detail={"message": f"Solver failed: {exc}"})


@app.get("/api/download/{scenario}/{filename}")
def download(scenario: str, filename: str, run_id: Optional[str] = None) -> StreamingResponse:
    scenario = scenario.upper()
    if filename not in OUTPUT_HEADERS:
        raise HTTPException(status_code=404, detail=f"Unknown output file '{filename}'")
    with _RUN_LOCK:
        saved = _RUNS.get(run_id) if run_id else None
        run = (saved["csv"] if saved and saved["scenario"] == scenario else None) if run_id else _LAST_RUN.get(scenario)
    if not run:
        raise HTTPException(status_code=404, detail=f"No run stored for scenario {scenario}")

    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=OUTPUT_HEADERS[filename], lineterminator="\n")
    writer.writeheader()
    for row in run[filename]:
        writer.writerow({k: row.get(k, "") for k in OUTPUT_HEADERS[filename]})
    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
