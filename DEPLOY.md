# Deploying to Google Cloud Run

One container, one service, one URL. The Docker build compiles the React bundle
and FastAPI serves it, so the UI and the API share an origin — no CORS setup, no
second hosting product, and `VITE_API_BASE` can stay unset.

Cloud Build builds straight from GitHub, so you don't need Docker or the gcloud
SDK on your laptop.

---

## 1. One-time setup in the console

**Prerequisites:** a Google Cloud project with billing enabled, and this repo
pushed to `github.com/lowkangxuan/nebula-x` on `main`.

1. Open **Cloud Run** → **Deploy container** → **Service**.
2. Choose **Continuously deploy from a repository** → **Set up with Cloud Build**.
3. Authenticate GitHub, pick the `lowkangxuan/nebula-x` repository.
4. Branch: `^main$`. Build type: **Dockerfile**, source location `/Dockerfile`.
5. Click **Save**. Accept the prompts to enable the Cloud Run, Cloud Build and
   Artifact Registry APIs if you haven't already.

## 2. Service settings that matter

| Setting | Value | Why |
| --- | --- | --- |
| Region | `asia-southeast1` (Singapore) | Matches the default weather coordinates in `06_PARAMETERS.csv` and keeps latency low for local judging. |
| Authentication | **Allow unauthenticated invocations** | Anyone with the link can open the demo. |
| Container port | `8080` | Left at the default; the container reads `$PORT`. |
| Memory | **2 GiB** | OR-Tools CP-SAT is memory-hungry; 512 MiB will OOM mid-solve. |
| CPU | **2** | CP-SAT parallelises its search across workers. |
| Request timeout | **300 s** | A cold solve plus an Open-Meteo fetch can exceed the 60 s default. |
| Min instances | **1** | Avoids cold starts, and keeps the active schedule alive (see below). |
| Max instances | **1** | **Required** — see below. |

### Why max instances must be 1

`backend/main.py` keeps solved runs in process memory (`_RUNS`, `_LAST_RUN`,
`_ACTIVE_RUN`). With two instances behind the load balancer, a `POST
/api/reschedule` handled by instance A and the follow-up `GET
/api/download/...` or `POST /api/schedule/activate` routed to instance B
returns **404 — no run stored**. Pinning to one instance removes the problem
entirely, and one instance handles a demo comfortably (80 concurrent requests,
solves run in a threadpool).

If you later want real horizontal scaling, move the run store out of process —
Firestore or a Cloud Storage bucket keyed by `run_id` is the smallest change.

### About `backend/state/`

Cloud Run's filesystem is an in-memory tmpfs: `active_schedule.json` and the
weather cache survive restarts of the *process* but not replacement of the
*instance*, and they count against the memory limit. With min instances 1 the
active schedule persists for the life of the demo. For durable state, write
that file to a GCS bucket instead.

## 3. Deploy and check

Cloud Build runs on Save and again on every push to `main`. When it finishes
you get a URL like `https://nebula-x-<hash>-as.a.run.app`.

```bash
curl https://<your-url>/api/health          # solver registration per scenario
curl -I https://<your-url>/                 # 200, text/html — the React bundle
```

Then open the URL, log in as `admin` / `admin123`, and confirm the timeline
renders and a CSV download works.

## 4. Known caveats

- **The login is not authentication.** `USERS` in `frontend/src/App.jsx` is
  hardcoded client-side. A public URL means anyone can pick the admin role. Fine
  for a hackathon demo, not for anything real.
- **Outbound weather calls.** Open-Meteo is reached over plain HTTPS egress,
  which Cloud Run allows by default. If you attach a VPC connector later you
  will also need Cloud NAT, or `/api/weather` starts returning 503.
- **Python version.** The image pins `python:3.13-slim` to match your local
  venv. If the OR-Tools wheel ever fails to resolve, drop the base image to
  `python:3.12-slim` — nothing in the codebase needs 3.13.
- **Cost.** Min instances 1 means you are billed for an always-warm instance
  (roughly a few dollars a month at this size). Set it back to 0 after judging,
  accepting cold starts and a reset active schedule.

## Fallback: deploying from your laptop

If you'd rather not connect GitHub, install the gcloud SDK and run from the
repo root:

```bash
gcloud run deploy nebula-x \
  --source . \
  --region asia-southeast1 \
  --allow-unauthenticated \
  --memory 2Gi --cpu 2 \
  --timeout 300 \
  --min-instances 1 --max-instances 1
```

`--source` uploads the repo and builds it with Cloud Build; you still don't
need Docker locally.
