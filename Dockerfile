# Track Access Scheduler — one image, one service.
# Stage 1 builds the React/Tailwind bundle; stage 2 runs FastAPI and serves that
# bundle itself, so the UI and the API share an origin and need no CORS config.

# ---------- stage 1: build the UI ------------------------------------------
FROM node:22-slim AS ui

WORKDIR /ui
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---------- stage 2: FastAPI + CP-SAT solver -------------------------------
FROM python:3.13-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./
# belt and braces: never ship the host venv, local state or tests
RUN rm -rf .venv state tests

COPY --from=ui /ui/dist ./static

# Cloud Run injects $PORT; 8080 is the default it uses.
EXPOSE 8080
CMD ["sh", "-c", "exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"]
