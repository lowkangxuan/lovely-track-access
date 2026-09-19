# Deploying the Track Access Scheduler to Google Cloud Run

One container, one service, one URL. The Docker build compiles the React bundle
and FastAPI serves it, so the UI and the API share an origin — no CORS setup, no
second hosting product, and `VITE_API_BASE` can stay unset.

Cloud Build does the building, so you need neither Docker nor a GitHub
connection. **Route A below uses only the browser**, which is what you want when
you are signed in with a hackathon-issued Google account that has no access to
your own GitHub repo.

---

## Route A — Cloud Shell (no local installs, no GitHub)

Cloud Shell is a terminal inside the Cloud console. It is already authenticated
as whichever account you are signed in with, and it ships with `gcloud` and
`unzip`.

1. Sign in to <https://console.cloud.google.com> with the hackathon credential
   and select the hackathon project in the project picker.
2. Click the **Activate Cloud Shell** icon (`>_`) in the top-right toolbar.
3. In the Cloud Shell toolbar: **⋮ → Upload → File**, and pick
   `nebula-x-deploy.zip` from this repo's root (124 KB — source only, no
   `node_modules`, no `.venv`).
4. In the shell:

   ```bash
   mkdir -p nebula-x && unzip -o nebula-x-deploy.zip -d nebula-x && cd nebula-x
   gcloud config set project <HACKATHON_PROJECT_ID>
   gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
   gcloud run deploy nebula-x \
     --source . \
     --region asia-southeast1 \
     --allow-unauthenticated \
     --memory 2Gi --cpu 2 \
     --timeout 300 \
     --min-instances 1 --max-instances 1
   ```

   `--source .` uploads the directory to Cloud Build, which builds the
   `Dockerfile` and pushes the image to Artifact Registry for you. Answer `y` if
   it offers to create the `cloud-run-source-deploy` repository.

5. The command prints a URL like `https://nebula-x-<hash>-as.a.run.app`.

To redeploy after a change: re-upload the zip (or edit in place with the Cloud
Shell editor) and run the same `gcloud run deploy` command again.

### If the hackathon account is missing a role

`gcloud run deploy --source` needs Cloud Run Admin, Cloud Build Editor,
Artifact Registry Writer, Storage Admin, and Service Account User on the
Compute default service account. Hackathon projects usually grant Editor or
Owner, which covers all of it. If a step fails with a `PERMISSION_DENIED`, the
message names the exact role — ask the organisers for that one rather than
guessing.

---

## Route B — gcloud CLI on your own machine

Same command as step 4, run from this repo's root instead of Cloud Shell.
Requires the gcloud SDK installed, then:

```bash
gcloud auth login          # sign in with the hackathon credential
gcloud config set project <HACKATHON_PROJECT_ID>
```

Still no Docker needed — the build happens in Cloud Build either way.

---

## Route C — continuous deployment from GitHub

Only viable if the account you deploy with can reach the repo. Cloud Run →
Deploy container → **Continuously deploy from a repository** → connect
`lowkangxuan/nebula-x`, branch `^main$`, build type **Dockerfile**. Every push
to `main` then redeploys. Worth switching to after the hackathon if the project
survives.

---

## Service settings that matter

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

---

## Check it worked

```bash
curl https://<your-url>/api/health          # solver registration per scenario
curl -I https://<your-url>/                 # 200, text/html — the React bundle
```

Then open the URL, log in as `admin` / `admin123`, and confirm the timeline
renders and a CSV download works.

## Known caveats

- **The login is not authentication.** `USERS` in `frontend/src/App.jsx` is
  hardcoded client-side. A public URL means anyone can pick the admin role. Fine
  for a hackathon demo, not for anything real.
- **Outbound weather calls.** Open-Meteo is reached over plain HTTPS egress,
  which Cloud Run allows by default. If you attach a VPC connector later you
  will also need Cloud NAT, or `/api/weather` starts returning 503.
- **Python version.** The image pins `python:3.13-slim` to match the local
  venv. If the OR-Tools wheel ever fails to resolve, drop the base image to
  `python:3.12-slim` — nothing in the codebase needs 3.13.
- **Cost.** Min instances 1 means an always-warm instance is billed. On a
  hackathon project with granted credits that is what you want during judging;
  set it back to 0 afterwards.

## Regenerating the upload bundle

`nebula-x-deploy.zip` is gitignored and goes stale as soon as you edit source.
Rebuild it from the repo root:

```bash
zip -r nebula-x-deploy.zip . \
  -x '*.git*' '*/.venv/*' '*/node_modules/*' '*/dist/*' '*/state/*' \
     '*/__pycache__/*' '*.pyc' '*.DS_Store' '*.zip'
```
