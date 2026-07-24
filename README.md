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
- `cmd/predictive-backend`: Cloud Run entrypoint for the private provider API.

The current provider is a private heuristic scorer. It evaluates runtime telemetry for memory pressure, memory growth, heap saturation, GC pressure, and process fanout while keeping the stored checkpoint fields public-safe.

## Configuration

The backend uses these public-safe environment variables:

- `PORT`
- `PREDICTIVE_PROVIDER_ID`
- `PREDICTIVE_MODEL_VERSION`

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

The deployment workflow is intentionally manual:

```text
.github/workflows/deploy-cloud-run.yml
```

It builds the private Docker image, pushes it to Artifact Registry, and deploys it to Cloud Run. The workflow uses GitHub OIDC; configure these repository secrets before running it:

- `GCP_WORKLOAD_IDENTITY_PROVIDER`: full Workload Identity Provider resource name.
- `GCP_DEPLOY_SERVICE_ACCOUNT`: deploy service account email.

The deploy service account needs permissions to push to the selected Artifact Registry repository and deploy/update the selected Cloud Run service.

Workflow inputs define the public-safe runtime configuration:

- `project_id`: Google Cloud project used by the public backend storage contract.
- `region`: Cloud Run and Artifact Registry region.
- `service`: Cloud Run service name.
- `artifact_registry_repository`: Artifact Registry Docker repository.
- `image_name`: container image name.
- `checkpoints`: comma-separated checkpoint windows for `PREDICTIVE_RELIABILITY_CHECKPOINTS`.
- `provider_id`: opaque `PREDICTIVE_PROVIDER_ID`.
- `model_version`: opaque `PREDICTIVE_MODEL_VERSION`.
- `allow_unauthenticated`: whether Cloud Run accepts unauthenticated HTTP requests.

Do not put model internals, thresholds, feature formulas, training data locations, or customer-specific tuning in workflow inputs, repository variables, or Cloud Run environment variables.
