# Build Process Watcher Predictive Provider

Private predictive reliability provider for Build Process Watcher.

This repository owns proprietary model execution, feature derivation, scoring thresholds, calibration, evaluation artifacts, and deployment-specific tuning. The public repository owns only the provider contract, checkpoint storage, API shape, server composition, and gated dashboard rendering.

## Boundary

- Do not copy model SQL, thresholds, feature formulas, evaluation reports, or customer-specific tuning into the public repository.
- Import only public Build Process Watcher packages such as `backend/pkg/predictor` and `backend/pkg/server`; do not import `backend/internal/*`.
- Return only public-safe `predictor.PredictionCheckpoint` values through the public `predictor.Provider` interface.
- Keep provider and model version identifiers opaque enough for public support logs.

## Shape

- `internal/provider`: private implementation of the public `predictor.Provider` contract.
- `internal/api`: private HTTP API that exposes health and prediction endpoints for the public backend to call.
- `internal/quality`: private recurring quality report over finished-run checkpoint outcomes, including baseline comparison and sparse-coverage callouts.
- `internal/relprogress`: private relative-progress checkpoint prototype and fixture study (not wired into live `/predict`).
- `internal/promotion`: private model refresh evaluation, independent checkpoint promotion gates, and promotion registry metadata for live scoring.
- `cmd/predictive-backend`: Cloud Run entrypoint for the private provider API.
- `cmd/quality-report`: generates the private markdown/JSON quality report from a controlled finished-run fixture or dataset.
- `cmd/relprogress-eval`: renders a private relative-progress evaluation report from fixture JSON.
- `cmd/model-refresh`: manual/scheduled dry-run and apply command for refresh and promotion decisions.

The current provider is a private heuristic scorer. It evaluates runtime telemetry for memory pressure, memory growth, heap saturation, GC pressure, and process fanout while keeping the stored checkpoint fields public-safe.

## Configuration

The backend uses these public-safe environment variables:

- `PORT`
- `PREDICTIVE_PROVIDER_ID`
- `PREDICTIVE_MODEL_VERSION`
- `PREDICTIVE_PROMOTED_MODELS`: optional per-checkpoint promoted model versions for live scoring. Accepts JSON registry shape `{"models":[{"observation_window_s":60,"model_version":"cp-60s-..."}]}`, JSON object `{"60":"cp-60s-..."}`, or comma-separated `60:cp-60s-...,300:cp-300s-...`. When a checkpoint window is absent, `PREDICTIVE_MODEL_VERSION` remains the fallback.

The deployment workflow also accepts `PREDICTIVE_RELIABILITY_CHECKPOINTS` as a Cloud Run environment variable so the public integration can keep checkpoint configuration aligned, but the private `/predict` request carries the checkpoint window to score.

## HTTP API

The service exposes only public-safe endpoints:

- `GET /healthz`: returns service health.
- `POST /predict`: accepts public run telemetry and returns one public-safe checkpoint.

Prediction requests use JSON:

```json
{
  "observation_window_s": 60,
  "run_id": "run-id",
  "samples": [
    {
      "elapsed_time": 60,
      "rss": 1572864,
      "heap_used": 900,
      "heap_cap": 1000,
      "gc_time": 5000
    }
  ],
  "process_info": {
    "123": {
      "pid": "123",
      "name": "GradleDaemon",
      "vm_flags": []
    }
  },
  "existing_checkpoints": [],
  "configured_windows": [30, 60, 180]
}
```

Responses wrap the public checkpoint:

```json
{
  "checkpoint": {
    "observation_window_s": 60,
    "status": "ready",
    "risk_level": "elevated",
    "risk_score": 0.4,
    "confidence": "medium",
    "predicted_peak_rss_mb": 2048,
    "predicted_duration_s": 67.2,
    "signals": ["memory pressure"],
    "provider_id": "private-provider",
    "model_version": "private-heuristic-v1"
  }
}
```

## Local Validation

```bash
go test ./...
go build ./cmd/predictive-backend
```

Generate the private recurring model quality report against a controlled fixture:

```bash
mkdir -p artifacts/quality-report
go run ./cmd/quality-report \
  -input internal/quality/testdata/complete.json \
  -out artifacts/quality-report
```

Sparse and no-promotable-model fixtures are also available for local review:

```bash
go run ./cmd/quality-report -input internal/quality/testdata/sparse.json -out artifacts/quality-report
go run ./cmd/quality-report -input internal/quality/testdata/no_promotable.json -out artifacts/quality-report
```

The command writes private artifacts to the `-out` directory:

- `quality-report.json`: checkpoint quality summary consumed by promotion review
- `quality-report.md`: human-readable error, risk-class, and baseline comparison report

Generated files under `artifacts/quality-report/` are local/private review outputs and are gitignored. The report summarizes cohort size, prediction MAPE, risk-class accuracy, baseline comparison, sparse coverage, and candidate model presence by checkpoint window. It does not include training corpus details, thresholds, feature formulas, or customer metadata.

Run the private relative-progress fixture study (advisory only; does not change the live provider):

```bash
go run ./cmd/relprogress-eval -input internal/relprogress/testdata/fixture_runs.json
```

Dry-run the automated model refresh and independent promotion gates against fixture quality-report input:

```bash
go run ./cmd/model-refresh \
  -dry-run \
  -report internal/promotion/testdata/quality_report_mixed.json \
  -registry internal/promotion/testdata/registry_previous.json
```

The dry-run prints refresh evaluation decisions for each v1 checkpoint window (`60`, `300`, `600`, `1200`), including promote and retain/no-promotion branches. Failed or sparse windows keep the previously promoted model version in the resulting registry metadata.

Apply mode writes the registry artifact used for live scoring:

```bash
go run ./cmd/model-refresh \
  -report /path/to/private-quality-report.json \
  -registry /path/to/promoted-models.json \
  -out /path/to/promoted-models.json
```

The local `go.mod` resolves the public `github.com/cdsap/build-process-watcher/backend` module directly from the merged public repository.

## Container Build

The Dockerfile builds the private backend binary and runs it on port `8080` for Cloud Run-compatible environments:

```bash
docker build -t bpw-predictive-backend .
docker run --rm -p 8080:8080 \
  -e PREDICTIVE_PROVIDER_ID=private-provider \
  -e PREDICTIVE_MODEL_VERSION=private-heuristic-v1 \
  bpw-predictive-backend
```

The container build expects `go.mod` to resolve the public backend module without a local filesystem `replace`.

## Cloud Run Deployment

The deployment workflow runs automatically when changes land on `main`, and can also be run manually:

```text
.github/workflows/deploy-cloud-run.yml
```

It builds the private Docker image, pushes it to Artifact Registry, and deploys it to Cloud Run. The workflow uses GitHub OIDC; configure these repository secrets before running it:

- `GCP_WORKLOAD_IDENTITY_PROVIDER`: full Workload Identity Provider resource name.
- `GCP_DEPLOY_SERVICE_ACCOUNT`: deploy service account email.

The deploy service account needs permissions to push to the selected Artifact Registry repository and deploy/update the selected Cloud Run service.

Manual workflow inputs define the public-safe runtime configuration. Automatic `main` deployments use the repository variable with the matching name when present, otherwise the listed default:

- `GCP_PROJECT_ID`: Google Cloud project used by the public backend storage contract. Defaults to `process-watcher-473421`.
- `GCP_REGION`: Cloud Run and Artifact Registry region. Defaults to `us-central1`.
- `CLOUD_RUN_SERVICE`: Cloud Run service name. Defaults to `bpw-predictive-backend`.
- `ARTIFACT_REGISTRY_REPOSITORY`: Artifact Registry Docker repository. Defaults to `bpw-private`.
- `IMAGE_NAME`: container image name. Defaults to `predictive-backend`.
- `PREDICTIVE_RELIABILITY_CHECKPOINTS`: comma-separated checkpoint windows. Defaults to `60,300,600,1200`.
- `PREDICTIVE_PROVIDER_ID`: opaque provider identifier stored with public-safe checkpoints. Defaults to `private-provider`.
- `PREDICTIVE_MODEL_VERSION`: opaque model version stored with public-safe checkpoints. Defaults to `private-heuristic-v1`.
- `ALLOW_UNAUTHENTICATED`: whether Cloud Run accepts unauthenticated HTTP requests. Defaults to `false`; production should keep this false.

Do not put model internals, thresholds, feature formulas, training data locations, or customer-specific tuning in workflow inputs, repository variables, or Cloud Run environment variables.

## Recurring Model Quality Report

Private checkpoint quality is reviewed through:

```text
.github/workflows/quality-report.yml
```

The workflow runs on a weekly schedule and can be started manually. Until live finished-run dataset paths are wired, scheduled runs use the checked-in complete fixture. Manual runs can point `-input` at another private fixture such as `internal/quality/testdata/sparse.json` or `internal/quality/testdata/no_promotable.json`.

Usage:

1. Produce or select a finished-run evaluation dataset that contains per-checkpoint current-model predictions, simple-baseline predictions, and actual outcomes.
2. Run `go run ./cmd/quality-report -input <dataset.json> -out artifacts/quality-report`.
3. Review `artifacts/quality-report/quality-report.md` for per-window error and risk-class quality, baseline comparison, and sparse/no-candidate callouts.
4. Use `artifacts/quality-report/quality-report.json` as the private quality-report input for promotion gates.

Do not copy generated quality-report artifacts, dataset paths containing customer metadata, thresholds, or feature formulas into the public Build Process Watcher repository.

## Automated Model Refresh And Promotion

Private checkpoint models refresh through:

```text
.github/workflows/model-refresh.yml
```

The workflow runs on a weekly schedule and can be started manually. Manual runs default to dry-run against fixture quality-report and registry inputs so promote and retain branches are proven without mutating live state.

Promotion behavior:

- Each checkpoint window is evaluated independently against the private quality gate.
- A window is promoted only when its quality gate passes and a candidate model version is present.
- Failed gates or sparse coverage leave the previously promoted model in place.
- Promotion metadata records `observation_window_s` and `model_version` for live scoring via `PREDICTIVE_PROMOTED_MODELS`.

### Required secrets and configuration

For apply-mode refresh against private training/quality data, configure the same GitHub OIDC deploy trust used by Cloud Run plus a training/quality service account:

- `GCP_WORKLOAD_IDENTITY_PROVIDER`: full Workload Identity Provider resource name.
- `GCP_TRAINING_SERVICE_ACCOUNT`: service account email allowed to read private quality-report inputs and write promotion registry artifacts in the private GCP project.
- Repository variable or workflow input paths for the private quality report and current promotion registry locations.

The training service account should be limited to the private dataset/object paths required for refresh and promotion metadata. Do not store model SQL, feature formulas, thresholds, or customer identifiers in GitHub variables.

Until those secrets and live quality-report paths are wired, scheduled runs remain dry-run and use the checked-in fixture report/registry pair.

### Rollback

Rollback is per checkpoint and does not require redeploying every window:

1. Automatic: a failed or sparse refresh keeps the previous promoted model version for that window, so live scoring continues on the last good version.
2. Manual: restore the previous `promoted-models.json` registry artifact (or set `PREDICTIVE_PROMOTED_MODELS` to the prior window/version map) and redeploy or update the Cloud Run service env var.
3. Fallback: clear a window from `PREDICTIVE_PROMOTED_MODELS` to fall back to `PREDICTIVE_MODEL_VERSION` for that checkpoint only.
