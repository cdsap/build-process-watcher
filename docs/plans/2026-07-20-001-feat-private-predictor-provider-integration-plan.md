---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
title: Private Predictor Provider Integration - Plan
type: feat
date: 2026-07-20
---

# Private Predictor Provider Integration - Plan

## Goal Capsule

| Field | Value |
|---|---|
| Objective | Make predictive reliability injectable from a private provider repo without requiring private code, model details, or scoring logic in the public Build Process Watcher repository. |
| Primary outcome | The public backend exposes a stable server composition API that defaults to `NoopProvider`, while a separate private checkout can build a prediction-enabled backend binary by supplying a real `predictor.Provider`. |
| Authority hierarchy | Public/private leakage boundary first; deployable private backend second; backward-compatible public backend behavior third. |
| Execution profile | Cross-repo integration plan: public repo package extraction and tests first, private provider repo bootstrap second. |
| Stop conditions | Do not publish real model formulas, thresholds, training SQL, feature importance, customer data, private provider names, or private repo URLs in public tracked files. |

---

## Product Contract

### Summary

The public repository already has the shape of predictive reliability: public-safe checkpoint records, a hidden UI surface, storage/API support, and a no-op provider contract.
The next useful step is not to put prediction logic into the public backend.
It is to make the backend composable so a private repository can inject the real provider and build its own deployment artifact.

The public project should remain useful to open-source users with prediction disabled.
The private deployment should be able to import the public server package, supply proprietary prediction behavior, and deploy the same HTTP API routes with prediction checkpoints enabled.

### Problem Frame

The current public `backend/main.go` owns too much composition directly: environment parsing, auth initialization, BigQuery exporter setup, storage initialization, handler construction, route registration, and `http.ListenAndServe`.
That is fine for the public no-op binary, but it gives a private provider repo no clean way to inject a real provider without copying public backend code or importing `internal/*` packages.

The public repo needs one stable composition boundary.
The private repo needs a minimal first provider implementation that proves the dependency and deployment path without exposing proprietary model work.

### Requirements

**Public backend composition**

- R1. Public `backend/main.go` must keep producing the same public no-op backend behavior when no private provider is supplied.
- R2. Public code must expose a package-level server API that accepts `predictor.Provider`, checkpoint configuration, and existing backend environment settings without importing private packages.
- R3. The server API must keep storage, auth, cleanup, BigQuery export, and route registration behavior equivalent to current `backend/main.go`.
- R4. The public package boundary must be importable from outside the backend module; private code must not need to import `backend/internal/*`.

**Private provider bootstrap**

- R5. The private provider repo must be able to build a backend binary that imports public `backend/pkg/predictor` and the new public server package.
- R6. The first private provider can be deterministic and conservative; it exists to prove integration, not to finalize production modeling.
- R7. Private provider outputs must return only public-safe `PredictionCheckpoint` fields.
- R8. Private provider errors must become public-safe checkpoint `error` records through the existing public handler path rather than blocking ingestion.

**Leakage and operability**

- R9. Public tests must continue to run without private credentials, private modules, or private repository access.
- R10. Public tracked docs and tests must describe provider attachment generically, not by exact private repository URL or private model implementation.
- R11. Private deployment configuration must enable checkpoints explicitly; disabled public deployments must not render prediction panels or emit fake real predictions.
- R12. The integration must preserve current public CI and Bazel build paths.

### Acceptance Examples

- AE1. Given the public backend is built from `backend/main.go`, when it starts with no private provider, then handlers receive `predictor.NoopProvider{}` and no prediction checkpoints are produced.
- AE2. Given a private backend binary imports the public server package and supplies a fake private provider, when a run reaches a configured checkpoint, then a public-safe prediction checkpoint is stored once for that window.
- AE3. Given a private provider returns an error, when ingest succeeds, then the request still returns success and the checkpoint record contains a generic error status.
- AE4. Given public CI runs in a clean checkout, when tests run, then no private repository access, private module download, or provider secret is required.
- AE5. Given a public diff is reviewed, when leak-scan tests run, then public tracked files contain provider contracts but not private model internals or exact private repo URLs.

### Scope Boundaries

#### In Scope

- Extract public backend composition into an importable package.
- Keep public `main.go` as a thin no-op binary.
- Add tests proving public server options choose no-op or injected providers correctly.
- Bootstrap the separate private provider repo with a minimal provider and backend entrypoint.
- Add private-side tests using synthetic telemetry only.
- Document the generic provider integration contract in public docs.

#### Deferred to Follow-Up Work

- Production-grade model training, validation, and calibration.
- Billing, tenancy, licensing, and commercial packaging.
- Hosted dashboard account management.
- Private provider CI/CD secrets and production rollout automation beyond a runnable first deployment shape.
- GitHub Action warnings or PR comments generated from predictions.

#### Outside This Product's Public Identity

- Publishing raw feature formulas, scoring cutoffs, model-family details, or training SQL.
- Naming private repository URLs or customer-specific artifacts in public tracked files.
- Treating checkpoint predictions as guaranteed OOM, timeout, or failure outcomes.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Extract `backend/pkg/server` as the public composition API.** The private provider repo needs a package it can import legally; `backend/internal/*` is intentionally unavailable outside the backend module.
- KTD2. **Keep `backend/main.go` no-op and boring.** The public binary should call the same server package with `predictor.NoopProvider{}` so public behavior remains the default and is easy to audit.
- KTD3. **Private repo builds a separate backend binary, not a plugin loaded by the public binary.** A separate binary avoids runtime plugin loading complexity, avoids private dependencies in public builds, and works cleanly with Cloud Run/container deploys.
- KTD4. **Use deterministic private bootstrap logic before real modeling.** The first private provider should prove wiring, checkpoint idempotency, and deployment shape with synthetic-safe logic before model iteration begins.
- KTD5. **Public docs stay generic.** The public repo may document package names, env vars, and provider contracts, but not exact private repo URLs, private provider identifiers, thresholds, feature weights, or model names.
- KTD6. **Private provider imports only public packages.** If private code needs a type that is still under `backend/internal`, the fix belongs in the public contract, not in a workaround.

### High-Level Technical Design

```mermaid
flowchart TB
  A[Public backend/main.go] --> B[backend/pkg/server.Run]
  A --> C[predictor.NoopProvider]
  D[Private backend main] --> B
  D --> E[Private provider implementation]
  B --> F[Auth initialization]
  B --> G[BigQuery exporter setup]
  B --> H[Firestore storage]
  B --> I[Handlers with provider]
  I --> J[Prediction checkpoint storage]
  J --> K[/runs response with prediction_checkpoints]
```

The public repo owns `backend/pkg/server` and `backend/pkg/predictor`.
The private repo owns the concrete provider and its backend entrypoint.
Both binaries use the same public handler/storage path, so dashboard behavior and API contracts do not fork.

### Public Server Contract

The new public server package should be intentionally small:

| Contract element | Purpose | Public/private boundary |
|---|---|---|
| `server.Options` | Carries provider, checkpoint windows, project id, port, and optional env-derived settings | Generic only |
| `server.Run(ctx, options)` | Initializes auth, storage, exporters, cleanup, handlers, routes, and HTTP serving | No private imports |
| `server.OptionsFromEnv()` | Parses current public env vars consistently for public and private binaries | No private secrets beyond generic config names |
| `server.NewMux(...)` or equivalent | Lets tests exercise route registration without binding a port | Public testability |
| `predictor.Provider` | Existing prediction interface implemented privately | Public-safe return contract |

### Sequencing

1. Extract public server composition while preserving current behavior.
2. Update public tests and Bazel targets for the new package.
3. Add generic public docs for provider attachment.
4. Bootstrap the private provider repo with a minimal backend binary and deterministic provider.
5. Add private integration tests using synthetic run data.
6. Run leak scans and full public verification before any public PR.

### Deferred to Implementation

- Decide whether `server.Run` should accept a prebuilt `http.Handler` for tests or expose `NewMux` separately after inspecting the cleanest Go test pattern.
- Decide whether the private repo should depend on the public repo through a tagged module version, branch pseudo-version, or temporary local replace during initial bootstrap.
- Decide whether provider checkpoint windows are fully env-driven in private deployments or hard-coded in the private binary for the first smoke test.

---

## Implementation Units

### U1. Extract Public Server Composition Package

- **Goal:** Move backend setup from `backend/main.go` into an importable public package without changing public runtime behavior.
- **Requirements:** R1, R2, R3, R4, R9, R12, AE1, AE4.
- **Dependencies:** None.
- **Files:** `backend/main.go`, `backend/pkg/server/server.go`, `backend/pkg/server/server_test.go`, `backend/pkg/server/BUILD.bazel`, `backend/BUILD.bazel`.
- **Approach:** Create `backend/pkg/server` that owns environment parsing, auth initialization, BigQuery exporter setup, storage setup, handler construction, cleanup route registration, and HTTP serving. Keep `backend/main.go` as a thin wrapper that passes `predictor.NoopProvider{}` and env-derived options. Expose a testable route-construction path so package tests do not bind a real network port.
- **Patterns to follow:** Preserve the current setup order in `backend/main.go`; follow the existing optional BigQuery behavior and the current handler construction pattern in `backend/internal/handlers/handlers.go`.
- **Test scenarios:**
  - Public `main.go` can compile with no private imports.
  - `server.OptionsFromEnv` parses existing BigQuery and checkpoint env vars consistently.
  - Empty provider defaults to `predictor.NoopProvider{}`.
  - Route registration includes `/healthz`, `/auth/run/`, `/ingest`, `/runs/`, `/finish/`, and `/cleanup/stale`.
  - Public server package tests run without binding a production port.
- **Verification:** `go test ./...` from `backend/`, `bazel test //...` from `backend/`, and `npm test -- --runInBand` from repo root.

### U2. Preserve Public No-Op Behavior And Boundary Tests

- **Goal:** Prove the extraction did not turn on predictions or leak private provider details in the public repo.
- **Requirements:** R1, R9, R10, R11, AE1, AE4, AE5.
- **Dependencies:** U1.
- **Files:** `__tests__/predictive-reliability-boundary.test.ts`, `README.md`, `backend/pkg/predictor/predictor_test.go`, `backend/pkg/server/server_test.go`.
- **Approach:** Extend existing public-boundary tests to allow generic server/provider contract language while rejecting exact private repo URLs, model internals, and predictive SQL terms. Keep README language at the contract level. Add Go tests that show the public default remains no-op unless an injected provider is supplied.
- **Patterns to follow:** Continue the current leak-scan pattern in `__tests__/predictive-reliability-boundary.test.ts`; keep README text concise like the existing BigQuery and predictive reliability notes.
- **Test scenarios:**
  - Leak scan fails on exact private repository URL text in tracked public files.
  - Leak scan still allows generic `predictor.Provider`, `prediction_checkpoints`, and `provider_id`.
  - Public no-op provider still reports disabled through `predictor.Enabled`.
  - Server default options do not produce real predictions.
- **Verification:** `npm test -- --runInBand`; focused Go tests for `backend/pkg/predictor` and `backend/pkg/server`.

### U3. Bootstrap Private Provider Repo Module

- **Goal:** Create the first private provider repo structure that can import the public contracts and build independently.
- **Requirements:** R5, R6, R7, R9, AE2, AE4.
- **Dependencies:** U1.
- **Files:** Private provider repo: `go.mod`, `cmd/predictive-backend/main.go`, `internal/provider/provider.go`, `internal/provider/provider_test.go`, `README.md`.
- **Approach:** Initialize a Go module in the private provider repo. Add a backend entrypoint that imports public `backend/pkg/server` and `backend/pkg/predictor`, constructs a deterministic provider, and calls the public server package. Use a local `replace` only for initial development if the public module version is not yet pushed or tagged; remove or document it before deploy.
- **Patterns to follow:** Keep private code outside the public repo. Mirror the public backend startup env names where possible so deployment differs only by binary/image and provider-specific private env vars.
- **Test scenarios:**
  - Private provider repo builds without importing public `backend/internal/*`.
  - Private backend entrypoint compiles against public `backend/pkg/server`.
  - Provider returns only public-safe fields.
  - Provider tests use synthetic telemetry fixtures.
- **Verification:** In the private provider repo, run `go test ./...` and a local build of `cmd/predictive-backend`.

### U4. Add Deterministic Private Provider Smoke Behavior

- **Goal:** Prove end-to-end checkpoint storage using a private provider before investing in real model work.
- **Requirements:** R6, R7, R8, R11, AE2, AE3.
- **Dependencies:** U3.
- **Files:** Private provider repo: `internal/provider/provider.go`, `internal/provider/provider_test.go`, `testdata/synthetic-run.json` or equivalent synthetic fixture.
- **Approach:** Implement conservative deterministic behavior that maps synthetic telemetry into public-safe labels such as `low`, `elevated`, `unknown`, and `memory pressure`, without encoding production thresholds or formulas. Add explicit error-path behavior for malformed snapshots.
- **Patterns to follow:** Return the existing public `PredictionCheckpoint` shape. Let the public handler convert provider errors to generic checkpoint errors instead of surfacing private error text.
- **Test scenarios:**
  - Provider returns a `ready` checkpoint for a valid synthetic snapshot.
  - Provider omits or rounds optional predicted values when confidence is low.
  - Provider uses opaque `provider_id` and `model_version` values.
  - Provider error text does not appear in public checkpoint messages.
- **Verification:** Private repo `go test ./...`; public repo handler tests continue to pass with fake/no-op providers.

### U5. Wire Private Deployment Smoke Path

- **Goal:** Make the private provider backend deployable enough for a first smoke test against the existing dashboard/API contract.
- **Requirements:** R5, R8, R11, R12, AE2, AE3.
- **Dependencies:** U1, U3, U4.
- **Files:** Private provider repo: `Dockerfile` or deployment config, private CI workflow if used, `README.md`; public repo: `README.md` only if generic public contract wording needs adjustment.
- **Approach:** Build a private backend image or binary that uses the public server package and the private provider. Configure explicit checkpoint windows through env vars. Keep public frontend behavior unchanged: prediction panels render only when backend data and frontend flags allow them.
- **Patterns to follow:** Mirror the public backend Docker/Cloud Run shape where practical, but keep private secrets and provider config in the private repo or deployment system.
- **Test scenarios:**
  - Private backend starts with configured checkpoint windows.
  - Health route works.
  - Synthetic ingest that reaches a checkpoint stores one checkpoint.
  - Duplicate ingest does not produce duplicate checkpoints.
  - `/runs/{runId}` returns public-safe `prediction_checkpoints` consumable by the existing dashboard.
- **Verification:** Private deployment smoke test plus public frontend tests from `npm test -- --runInBand`.

### U6. Final Public/Private Release Gate

- **Goal:** Ensure the public branch is safe to publish and the private branch is independently usable.
- **Requirements:** R9, R10, R12, AE4, AE5.
- **Dependencies:** U1, U2, U3, U4, U5.
- **Files:** Public repo: `__tests__/predictive-reliability-boundary.test.ts`, `.gitignore`, `README.md`; private provider repo: release notes or README.
- **Approach:** Review public tracked changes for private leakage, run full public verification, and run private verification separately. Confirm the private provider repo owns all implementation detail and the public repo owns only contract/composition code.
- **Patterns to follow:** Use the public leak-scan test as the automated floor, then do a manual public diff review because automated patterns cannot detect every business-sensitive phrase.
- **Test scenarios:**
  - Public leak scan passes.
  - Public Go, Bazel, and Jest suites pass.
  - Private provider tests pass.
  - Private backend smoke path passes against synthetic data.
- **Verification:** Public `npm test -- --runInBand`, public backend `go test ./...`, public backend `bazel test //...`, private repo `go test ./...`, and manual public diff review.

---

## Verification Contract

| Verification | Applies to | Expected signal |
|---|---|---|
| `npm test -- --runInBand` | U2, U5, U6 | Public static, metadata, dashboard, and leak-scan tests pass without private access. |
| `go test ./...` from `backend/` | U1, U2, U6 | Public backend, server composition, handlers, storage, and predictor contracts pass. |
| `bazel test //...` from `backend/` | U1, U6 | Public Bazel graph includes `backend/pkg/server` and remains private-dependency-free. |
| Private repo `go test ./...` | U3, U4, U5, U6 | Private provider compiles, returns public-safe checkpoints, and does not import public `internal/*`. |
| Private backend smoke test | U5, U6 | Synthetic ingest reaches a checkpoint and `/runs/{runId}` returns one public-safe checkpoint. |
| Manual public diff review | U2, U6 | Public tracked files contain contracts and generic docs only, with no exact private repo URL or model internals. |

---

## Definition of Done

- Public `backend/main.go` is a thin no-op wrapper around an importable server package.
- Public `backend/pkg/server` lets private code inject a `predictor.Provider` without importing `backend/internal/*`.
- Public tests prove no-op defaults, generic provider contracts, route registration, and leak boundaries.
- Private provider repo has a buildable backend entrypoint using the public server package.
- Private provider repo has deterministic synthetic tests and no production model assumptions baked into public code.
- A private smoke path can store and return at least one public-safe checkpoint through the existing `/runs/{runId}` response.
- Public verification passes without private repo access.
- Private verification passes separately.
- Public tracked files do not name private repository URLs, private model internals, scoring cutoffs, training SQL, feature formulas, customer data, or abandoned experimental code.
