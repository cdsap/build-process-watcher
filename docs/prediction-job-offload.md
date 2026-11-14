# Prediction job offload (Cloud Tasks)

`/ingest` must only store samples and enqueue evaluation. TabFM/TimesFM must not run on the ingest request: Cloud Run keeps the client open until the handler returns, which caused ~20s sample holes.

## Flow

1. `POST /ingest` → `StoreSamples` → `Cloud Tasks CreateTask` (~ms) → `200`
2. Cloud Tasks → `POST /internal/prediction-jobs` with `X-BPW-Prediction-Job-Token`
3. Job handler runs `CheckpointEvaluator` + `ForecastEvaluator`

## Required secrets / env (Deploy Backend)

| Name | Example | Purpose |
|---|---|---|
| `PREDICTION_TASKS_QUEUE` | `bpw-prediction` | Cloud Tasks queue id |
| `PREDICTION_TASKS_LOCATION` | `us-central1` | Queue location |
| `PREDICTION_JOB_URL` | `https://…run.app/internal/prediction-jobs` | HTTP target |
| `PREDICTION_JOB_TOKEN` | long random secret | Shared auth header |

Create the queue once:

```bash
gcloud tasks queues create bpw-prediction --location=us-central1
```

Grant the Cloud Run runtime service account `roles/cloudtasks.enqueuer` on the queue.

Without these env vars the backend still ingests samples but skips prediction scheduling (noop scheduler).
