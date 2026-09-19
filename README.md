# Lovely Track Access 💙

**LTA** — railway track access optimisation.

Decision-support tool for LTA track-access planners and 2 AM works controllers.
Answers PS1 — *Railway Track Access Optimisation* for the dual-line network
(Line Alpha `ALP` / Line Beta `BET`).

```
backend/     FastAPI service + pluggable solver package
frontend/    React + Tailwind + lucide-react dashboard
```

---

## Quick start

**Demo**: https://nebula-x-1003639741182.asia-southeast1.run.app/

## Local Setup
**Backend** (port 8000)

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

**Frontend** (port 5173)

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173.
The app boots against the reference instance bundled in `backend/data/`, so the
dashboard is populated before anything is uploaded.

In dev the UI calls `/api/*` on its own origin and Vite proxies those to
uvicorn on 8000. In a container build the React bundle is copied to
`backend/static` and FastAPI serves it, so one Cloud Run service covers both —
see [DEPLOY.md](DEPLOY.md).

## Login Credentials

| user    | password   | scope                        |
| ------- | ---------- | ---------------------------- |
| `admin` | `admin123` | every contract + Reschedule  |
| `eng1`  | `pass123`  | contract `C001` only         |

---

## API

| method | path | purpose |
| ------ | ---- | ------- |
| `GET`  | `/api/health` | liveness + which solver is registered per scenario |
| `GET`  | `/api/schemas` | the 8 required CSV headers — the UI validates against this, so browser and server can't drift |
| `GET`  | `/api/schedule?scenario=A` | solve the bundled reference instance |
| `POST` | `/api/reschedule` | `multipart/form-data`: the 8 instance CSVs under `files` + `scenario` (`A`/`B`/`C`) |
| `GET`  | `/api/download/{scenario}/{file}` | `SCHEDULE_ACCESS.csv` \| `SCHEDULE_OCCUPANCY.csv` \| `RESULTS.csv` from the last run |

`POST /api/reschedule` returns the three submission tables plus a flattened
view-model (one row per activity-access, pre-joined with `07_PROJECT_DETAILS`
and `08_ACTIVITY_DETAILS`) so the UI never re-joins CSVs client-side.

---

## Swapping in your own solver

`solver/registry.py` is the only seam. Write a callable with the signature

```python
def solve(scenario: str, data: InstanceData) -> SolveOutput: ...
```

and register it:

```python
from solver.registry import register
from myteam.cpsat import solve as cpsat_solve

register("A", cpsat_solve)   # scenario-specific
register("*", cpsat_solve)   # or the new default for all scenarios
```

Nothing else changes — the API contract, the CSV writers and the whole React UI
keep working. `InstanceData` and `SolveOutput` are Pydantic models in
`solver/schemas.py`.

```
solver/
  schemas.py     Pydantic models + the canonical CSV header registry
  loader.py      CSV -> InstanceData, header validator + referential checks
  network.py     location-id grammar, path expansion, buffer footprints, week maths
  policies.py    the A / B / C rule sets (excess cap, ECLO, deadline, continuity)
  optimizer.py   CP-SAT solver seeded by a multi-start greedy  <- registered for A, B, C
  baseline.py    the original greedy solver, still the "*" fallback
  validation.py  read-only hard-rule checker run on every emitted schedule
  scoring.py     soft scores + the §2.5 combined objective
  registry.py    solve_scenario() dispatch  <- register here
```

---

## What the solver does

Scenarios `A`, `B` and `C` are registered to `solver/optimizer.py`: a
time-indexed CP-SAT model (OR-Tools) over `(activity, week, possession night)`
booleans, seeded with the best of several greedy constructions. The greedy
always finishes the full workload (extending the calendar under congestion), so
there is always a complete incumbent; CP-SAT then minimises the scenario
objective within the incumbent's horizon and night palette and reports its
search status in `detail.search_status`. If CP-SAT cannot improve on the greedy
seed within the time limit (`SOLVER_TIME_LIMIT_SECONDS`, default 15 s), the
seed is returned with `detail.fallback_used = true`.

The model's objective is the §2.5 formula scaled by 10 (so `objective_bound` is
reported as `best_objective_bound / 10`): overrun days weighted 100/10/1 by
contract tier and 1.3/1.2/1.0 by activity tier, 7 per excess access-night, 5
per ECLO night. `B` drops the overrun term (dates are hard there).

`baseline.py` remains registered as `"*"` and is only used if a scenario is
deregistered.

Hard rules enforced (and independently re-checked by `validation.py` on every
emitted schedule):

1. **Workload conservation** — every activity reaches `total_accesses` units
2. **Planned start date** — no access before the planned start week
3. **Predecessor** — finish-to-start, zero lag, strictly later week
4. **Closures & buffers** — exclusion ring from `05_BUFFER_LOCATION`, 750V
   opposite-bound mirroring, and the `Live`-only `H01_H02` cross-line closure
5. **Legal mixes** — per slot: one `PM` alone, or one `PC` + ≤3 `C`, or ≤4 `C`
6. **Co-sharing** — same `(location, week, co_share_group)` is one possession
7. **Weekly allocation** — ≤ `number_of_maximum_access_per_week` distinct nights
8. **Workfronts** — ≤ `number_of_workfronts` activities per `access_night`
9. **ECLO** — 1.5 units/night; forbidden in A
10. **ECLO continuity** — Scenario C: one ≤2-week window per line

Scenario gates: `A` hard-fails capacity excess and any ECLO; `C` allows 1 excess
access-night per location-week; `B` allows unlimited excess but hard-fails any
overrun past `planned_completion_date`.

### Reference-instance results

CP-SAT proves all three optimal within the bounded model, in well under a second
each.

| scenario | feasible | activities scheduled | overrun days | ECLO | excess nights | objective |
| -------- | -------- | -------------------- | ------------ | ---- | ------------- | --------- |
| A | yes | 54 / 54 | 21 (C006 +14, C010 +7) | 0 | 0 | 25.2 |
| B | yes | 54 / 54 | 0 | 6 | 0 | 30.0 |
| C | yes | 54 / 54 | 21 (C006 +14, C010 +7) | 0 | 0 | 25.2 |

`C` coincides with `A` on this instance: with the overrun weighted at 1/day for
tier-3 contracts, neither an ECLO night (5) nor an excess access-night (7) buys
enough schedule to pay for itself.

### Documented modelling decisions

The published submission format cannot express which two possessions at
*different* locations fall on the same night (`access_night` is explicitly a
per-contract accounting index, independent of location). Consequences:

* `supply_capacity` at a location-week is read as the number of possession
  slots (nights) available there that week. Excess access-nights are slots used
  beyond that capacity.
* `co_share_group` (`night-N`) is the **physical night** witness: the label is
  consistent across every location an activity occupies in a week, and across
  activities, so `night-1` at two different locations in the same week is the
  same night. `access_night` is then the rank of that slot among the nights the
  contract uses that week.
* **One access per activity per week.** Each activity gets at most one night in
  any given week; a 5-access activity therefore spans at least 5 weeks. This is
  inherited from the baseline and is the main driver of overrun — revisit it if
  the specification permits several nights per week for one activity.
* Buffer conflicts are evaluated at **night** granularity (same week, same
  `co_share_group`) between the two activities' full closure footprints
  (worked path + exclusion ring, on both bounds if mirrored). Two footprints that
  overlap anywhere — including only at a shared platform between their rings —
  may not share a night, **unless** the activities work a common location and
  form a legal possession mix, in which case they co-share one possession. This
  is stricter than "no work inside another's ring" and can cost packing
  density; it never produces a breach.
* A platform-only job books only that platform (not the two adjacent tunnels);
  its exclusion ring extends `up_to_buffer_sectors` tunnel sectors in each
  direction. A tunnel job's ring also includes the platforms bounding each
  buffered sector.
* An activity's `lines_touched` (used for the Scenario C ECLO window) is
  derived from its full footprint, so a `Live` job at `H01_H02` consumes the
  ECLO window on both lines.

---

## Frontend structure

`src/App.jsx` provides the dashboard shell and live API integration:

* `Login` — hardcoded credentials, RBAC scope attached to the session
* `TimelineStrip` — sticky chronological week histogram; click a week to scroll
  the card rail to it. Bars colour by on-target / ECLO / overrun.
* `TaskCard` — minimalist 3-column card: `contract:activity` · `location_id` ·
  `date / week`, in a horizontally scrollable rail sorted earliest → latest
* `ScheduleControls` — project-code search, activity-priority and occupied-location
  filters, a live network station picker, and list/month views. Filters apply after
  the user's contract scope. Calendar colours use **activity priority**: P1 (highest)
  rose, P2 amber, P3 (lowest) sky blue, with text labels and a legend. ECLO and
  overrun appear as additional labels. Calendar dates are week starts, matching
  the scheduler's date model; overflow opens all possessions for that date.
* `KdaDialog` — the current full schedule's scenario rubric, including feasibility,
  weighted overrun, excess nights, ECLO and objective contributions. Filters do not
  change the full-schedule KDA. Uploaded schedules and scenario changes refresh it.
* `ActivityModal` — schedule metrics (scheduled date/week, access nights, days
  delayed vs `planned_completion_date`), possession occupancy with slot labels,
  then the full `08_ACTIVITY_DETAILS` and `07_PROJECT_DETAILS` context
* `RescheduleModal` — admin only. Batch dropzone for the 8 CSVs, client-side
  header validation against `GET /api/schemas` with per-file error messages,
  scenario selector, and a Run button that only enables once all 8 files are
  valid and a scenario is chosen.

Point the UI at a different backend with `VITE_API_BASE` (see
`frontend/.env.example`).

Frontend checks: `cd frontend && npm test && npm run build`.
