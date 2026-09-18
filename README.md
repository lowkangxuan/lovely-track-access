# Railway Track Access Scheduler

Decision-support tool for LTA track-access planners and 2 AM works controllers.
Answers PS1 — *Railway Track Access Optimisation* for the dual-line network
(Line Alpha `ALP` / Line Beta `BET`).

```
backend/     FastAPI service + pluggable solver package
frontend/    React + Tailwind + lucide-react dashboard
```

---

## Quick start

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

| user    | password   | scope                        |
| ------- | ---------- | ---------------------------- |
| `admin` | `admin123` | every contract + Reschedule  |
| `eng1`  | `pass123`  | contract `C001` only         |

The app boots against the reference instance bundled in `backend/data/`, so the
dashboard is populated before anything is uploaded.

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
  schemas.py    Pydantic models + the canonical CSV header registry
  loader.py     CSV -> InstanceData, with the header validator the UI mirrors
  network.py    location-id grammar, path expansion, buffer footprints, week maths
  baseline.py   the default greedy solver  <- replace this
  scoring.py    soft scores + the §2.5 combined objective
  registry.py   solve_scenario() dispatch  <- register here
```

---

## What the baseline solver does

Multi-start greedy: several structurally different dispatch orders (contract
tier, slack, planned start, criticality), then an adaptive pass that promotes
whatever overran and re-solves. Deterministic, ~0.2 s per scenario on the
reference instance.

Hard rules enforced:

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

| scenario | feasible | activities scheduled | overrun days | ECLO | excess nights | objective |
| -------- | -------- | -------------------- | ------------ | ---- | ------------- | --------- |
| A | yes | 54 / 54 | 329 | 0 | 0 | 2426.9 |
| B | **no** — 2 date violations | 54 / 54 | 84 | 104 | 0 | — |
| C | yes | 54 / 54 | 189 | 7 | 2 | 1237.6 |

Scenario B is the honest weak spot of the *baseline*: dates are a hard gate
there and greedy dispatch cannot close the last two contracts. It is exactly the
case a real optimiser registered through `registry.py` should fix.

### Documented modelling decisions

The published submission format cannot express which two possessions at
*different* locations fall on the same night (`access_night` is explicitly a
per-contract accounting index, independent of location). Two consequences:

* `supply_capacity` at a location-week is read as the number of possession
  slots (nights) available there that week; `co_share_group` labels the slot.
  Excess access-nights are slots used beyond that capacity.
* Buffer conflicts are evaluated at **week** granularity, between one activity's
  strict exclusion ring (buffer zone minus its own worked path) and another
  activity's worked path. This is conservative — it can cost packing density,
  never produce a breach.

The exclusion ring is measured in tunnel sectors, matching
`05_BUFFER_LOCATION.up_to_buffer_sectors`; platforms enter a footprint only
where they are actually worked.

---

## Frontend structure

`src/App.jsx` is self-contained:

* `Login` — hardcoded credentials, RBAC scope attached to the session
* `TimelineStrip` — sticky chronological week histogram; click a week to scroll
  the card rail to it. Bars colour by on-target / ECLO / overrun.
* `TaskCard` — minimalist 3-column card: `contract:activity` · `location_id` ·
  `date / week`, in a horizontally scrollable rail sorted earliest → latest
* `ActivityModal` — schedule metrics (scheduled date/week, access nights, days
  delayed vs `planned_completion_date`), possession occupancy with slot labels,
  then the full `08_ACTIVITY_DETAILS` and `07_PROJECT_DETAILS` context
* `RescheduleModal` — admin only. Batch dropzone for the 8 CSVs, client-side
  header validation against `GET /api/schemas` with per-file error messages,
  scenario selector, and a Run button that only enables once all 8 files are
  valid and a scenario is chosen.

Point the UI at a different backend with `VITE_API_BASE` (see
`frontend/.env.example`).
