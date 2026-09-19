# Deploying the Track Access Scheduler to Google Cloud Run

One container, one service, one URL. The Docker build compiles the React bundle
and FastAPI serves it, so the UI and the API share an origin — no CORS setup, no
second hosting product, and `VITE_API_BASE` can stay unset.

Cloud Build does the building, so you need neither Docker nor a GitHub
connection. **Route A below uses only the browser**, which is what you want when
you are signed in with a hackathon-issued Google account that has no access to
your own GitHub repo.

Throughout: the Cloud Run service is named **`lovely-track-access`** and the
upload bundle is **`lovely-track-access-deploy.zip`**.

---

## Route A — Cloud Shell (no local installs, no GitHub)

Cloud Shell is a terminal inside the Cloud console. It is already authenticated
as whichever account you are signed in with, and it ships with `gcloud` and
`unzip`.

1. Sign in to <https://console.cloud.google.com> with the hackathon credential
   and select the hackathon project in the project picker.
2. Click the **Activate Cloud Shell** icon (`>_`) in the top-right toolbar.
3. Upload `lovely-track-access-deploy.zip` from this repo's root (~350 KB,
   source only — no `node_modules`, no `.venv`):
   - **Terminal view:** `⋮` **More** → **Upload**.
   - **Editor view:** right-click your home folder in the **Explorer** panel →
     **Upload Files**.

   Uploads always land in your home directory; that is a Cloud Shell rule, not
   a permissions problem.
4. In the terminal:

   ```bash
   rm -rf ~/lovely-track-access
   unzip ~/lovely-track-access-deploy.zip -d ~/lovely-track-access
   cd ~/lovely-track-access

   gcloud config set project <HACKATHON_PROJECT_ID>
   gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com

   gcloud run deploy lovely-track-access \
     --source . \
     --region asia-southeast1 \
     --allow-unauthenticated \
     --memory 2Gi --cpu 2 \
     --timeout 300 \
     --min-instances 1 --max-instances 1
   ```

   There is no GUI "extract" in Cloud Shell — `unzip` is a command you type.
   `--source .` uploads the directory to Cloud Build, which builds the
   `Dockerfile` and pushes the image to Artifact Registry for you. Answer `y` if
   it offers to create the `cloud-run-source-deploy` repository.

5. The command prints a URL like
   `https://lovely-track-access-<hash>-as.a.run.app`.

### Redeploying after a change

Settings already on the service persist, so the redeploy is the short form:

```bash
cd ~/lovely-track-access
gcloud run deploy lovely-track-access --source . --region asia-southeast1
```

If the change was made on your laptop rather than in the Cloud Shell editor,
rebuild the bundle (see the last section), then:

```bash
rm -f ~/lovely-track-access-deploy.zip     # BEFORE re-uploading
# ...upload the new zip...
rm -rf ~/lovely-track-access
unzip ~/lovely-track-access-deploy.zip -d ~/lovely-track-access
cd ~/lovely-track-access
gcloud run deploy lovely-track-access --source . --region asia-southeast1
```

That first `rm -f` matters: if a zip of the same name is already in your home
directory, the upload lands as `lovely-track-access-deploy (1).zip` and you will
redeploy the old code without noticing.

**Budget five minutes per deploy.** Each `--source` build runs on a fresh Cloud
Build worker with no layer cache, and the OR-Tools wheel is most of that. Do not
save a change for ten minutes before judging.

### If you already deployed under the old `nebula-x` name

That service is still running, still public, and still billing for a warm
instance. Delete it so there is only one URL in play:

```bash
gcloud run services delete nebula-x --region asia-southeast1
```

---

## Route B — gcloud CLI on your own machine

Same commands as Route A step 4, run from this repo's root instead of Cloud
Shell. Requires the gcloud SDK installed, then:

```bash
gcloud auth login          # sign in with the hackathon credential
gcloud config set project <HACKATHON_PROJECT_ID>
```

Still no Docker needed — the build happens in Cloud Build either way.

---

## Route C — continuous deployment from GitHub

Only viable if the account you deploy with can reach the repo. Cloud Run →
Deploy container → **Continuously deploy from a repository** → connect the
repo, branch `^main$`, build type **Dockerfile**. Every push to `main` then
redeploys. Worth switching to after the hackathon if the project survives.

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

### If the hackathon account is missing a role

`gcloud run deploy --source` needs Cloud Run Admin, Cloud Build Editor,
Artifact Registry Writer, Storage Admin, and Service Account User on the
Compute default service account. Hackathon projects usually grant Editor or
Owner, which covers all of it. If a step fails with `PERMISSION_DENIED`, the
message names the exact role — ask the organisers for that one rather than
guessing.

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

`lovely-track-access-deploy.zip` is gitignored and goes stale as soon as you
edit source. Rebuild it from the repo root:

```bash
zip -r lovely-track-access-deploy.zip . \
  -x '*.git*' '*/.venv/*' '*/node_modules/*' '*/dist/*' '*/state/*' \
     '*/__pycache__/*' '*.pyc' '*.DS_Store' '*.zip'
```
