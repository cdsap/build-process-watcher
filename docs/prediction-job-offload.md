# Prediction job offload (Cloud Tasks)

Operator reference for the current timeline backend. Consumer setup and release
compatibility are in the [forecast guide](forecast-guide.md).

`/ingest` must only store samples and enqueue evaluation. TabFM/TimesFM must not run on the ingest request: Cloud Run keeps the client open until the handler returns, which caused ~20s sample holes.

## Flow

1. `POST /ingest` → `StoreSamples` → `Cloud Tasks CreateTask` (~ms) → `200`
2. Cloud Tasks → `POST /internal/prediction-jobs` with `X-BPW-Prediction-Job-Token`
3. Job handler runs `ForecastEvaluator` (timeline process forecasts)

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

## Diagnose ingestion and prediction separately

Successful sample ingestion proves storage, not scheduling or inference. Task-enqueue
failures are logged and do not fail an otherwise successful ingest. A
missing provider is a no-op; provider errors are logged without appending model
issuances. A job HTTP 200 is an acknowledgement, not proof of model execution.

Check in order: advancing stored samples; scheduler configuration and enqueue
errors; task delivery/authentication; evaluator/provider errors; then newly stored
`process_forecasts` with method/fallback metadata. Compare selected
`prediction_mode` with observed methods. Last-value fallback is distinguishable
from primary inference, and empty forecasts must be reported as unavailable or
pending even while samples continue. Keep deployment values and diagnostic logs
out of consumer screenshots.

TabPFN validation is conditional on an already available VM. Do not start its VM
or make it an always-on documentation-validation dependency.
