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
- `cmd/predictive-backend`: private backend entrypoint that injects the provider into the public `server.Run` composition API.

The current provider is a private heuristic scorer. It evaluates runtime telemetry for memory pressure, memory growth, heap saturation, GC pressure, and process fanout while keeping the stored checkpoint fields public-safe.

## Configuration

The backend uses the public environment variables from Build Process Watcher, including:

- `GOOGLE_CLOUD_PROJECT`
- `PORT`
- `PREDICTIVE_RELIABILITY_CHECKPOINTS`

Private provider metadata can be set with:

- `PREDICTIVE_PROVIDER_ID`
- `PREDICTIVE_MODEL_VERSION`

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
  -e GOOGLE_CLOUD_PROJECT=your-project \
  -e PREDICTIVE_RELIABILITY_CHECKPOINTS=30,60,180 \
  -e PREDICTIVE_PROVIDER_ID=private-provider \
  -e PREDICTIVE_MODEL_VERSION=private-heuristic-v1 \
  bpw-predictive-backend
```

The container build expects `go.mod` to resolve the public backend module without a local filesystem `replace`.
