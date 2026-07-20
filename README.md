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

The current provider is a deterministic bootstrap smoke implementation. It proves private injection, public-safe checkpoint output, and error handling before production model work begins.

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

The local `go.mod` uses a `replace` directive to point at a sibling checkout of `github.com/cdsap/build-process-watcher/backend` while the public provider contract is being prepared.

## Container Build

The Dockerfile builds the private backend binary and runs it on port `8080` for Cloud Run-compatible environments:

```bash
docker build -t bpw-predictive-backend .
docker run --rm -p 8080:8080 \
  -e GOOGLE_CLOUD_PROJECT=your-project \
  -e PREDICTIVE_RELIABILITY_CHECKPOINTS=30,60,180 \
  -e PREDICTIVE_PROVIDER_ID=private-provider \
  -e PREDICTIVE_MODEL_VERSION=bootstrap-v0 \
  bpw-predictive-backend
```

The container build expects `go.mod` to resolve the public backend module without a local filesystem `replace`. After the public server/predictor contract lands in the public repository, remove the local `replace`, run `go mod tidy`, and then build the image.
