---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
title: Private Predictive Reliability - Plan
type: feat
date: 2026-07-18
---

# Private Predictive Reliability - Plan

## Goal Capsule

| Field | Value |
|---|---|
| Objective | Add predictive reliability as a hidden, configuration-gated capability while keeping non-public prediction implementation details outside the public repository. |
| Primary outcome | The public repo exposes stable prediction contracts and safe UI/API surfaces, while private deployments can attach proprietary prediction providers and iterate on models without public commits. |
| Authority hierarchy | User privacy and business-model constraint first; backward-compatible public API second; model iteration speed third. |
| Execution profile | Deep feature plan touching backend models, storage, handlers, frontend rendering, docs, tests, and release hygiene. |
| Stop conditions | Do not commit proprietary prediction assets, private deployment code, or private evaluation material to the public repo. |

---

## Product Contract

### Summary

Predictive reliability should become a commercial feature surface rather than a public implementation dump.
The public Build Process Watcher repo should support a hidden prediction panel, a backend prediction contract, and disabled-by-default configuration.
The proprietary value should live in a private provider that can change independently while the public repo exposes only stable contracts.

### Problem Frame

The current predictive reliability work proves the idea with BigQuery ML SQL templates and an N-second checkpoint plan.
That is useful for local design, but publishing those templates would expose too much of how the feature works.
The implementation needs an architectural boundary that lets the public project advertise and carry prediction results without revealing the private model pipeline.

### Requirements

**Visibility and access**

- R1. Prediction surfaces must be hidden by default in public builds and disabled unless explicit backend configuration enables them.
- R2. The dashboard must tolerate missing predictions and render the existing run experience unchanged for old runs, local artifacts, and public deployments.
- R3. Public documentation must describe the feature at an integration-contract level, not at a model-implementation level.
- R4. Any public sample/demo prediction data must be synthetic and must not reveal private implementation details.

**Public/private boundary**

- R5. The public repo may define generic prediction records, provider interfaces, feature flags, and UI rendering for already-computed prediction results.
- R6. The private implementation must own all proprietary prediction behavior and rollout gates.
- R7. Public backend code must degrade cleanly when no private provider is installed or configured.
- R8. Public tests must use fake or deterministic stub providers rather than real model logic.

**Iteration and business model**

- R9. Prediction results must support multiple checkpoints per run, keyed by `observation_window_s`, so the feature can evolve from 30s/60s into project-specific intervals.
- R10. Prediction records must include enough metadata for iteration: provider id, model version, generated timestamp, confidence, status, and explanatory public-safe signals.
- R11. The design must support later packaging tiers such as self-hosted OSS without prediction, private hosted prediction, and paid enterprise provider attachment.
- R12. The implementation must allow model versions and confidence semantics to change without requiring dashboard rewrites or public schema churn.

### Acceptance Examples

- AE1. Given prediction config is absent, when `/runs/{runId}` returns a run, then no prediction fields are shown in the dashboard and the response remains compatible with current consumers.
- AE2. Given a private provider is configured and a run reaches a checkpoint, when ingest stores enough samples, then the backend stores one prediction record for that checkpoint and does not repeat it.
- AE3. Given a run has `30s`, `60s`, and `180s` prediction records, when the dashboard renders, then each checkpoint appears separately with confidence and timing, not as a single final verdict.
- AE4. Given a public PR is prepared, when release hygiene checks run, then proprietary prediction assets and private deployment references are absent from the public diff.
- AE5. Given a provider returns an error, when ingest succeeds, then telemetry storage still succeeds and prediction status records the failure without blocking the run.

### Scope Boundaries

#### In Scope

- Define public prediction data contracts.
- Add hidden feature flags and configuration gates.
- Add a public provider interface with fake/no-op implementations.
- Add storage/API support for prediction checkpoint records.
- Add dashboard rendering for safe prediction output.
- Add public/private release hygiene checks.
- Document the provider contract and commercial boundary.

#### Deferred to Follow-Up Work

- Build the proprietary provider implementation in a private repository.
- Train, evaluate, and version production models.
- Add billing, license enforcement, or SaaS tenant management.
- Add account-specific dashboards or hosted account management.
- Add automated GitHub Action warnings from predictions.

#### Outside This Product's Public Identity

- Publicly documenting proprietary prediction internals or private deployment details.
- Shipping private evaluation reports in this repository.
- Treating advisory resource risk as a guaranteed OOM, timeout, or failure probability.

---

## Planning Contract

### Key Technical Decisions

- KTD1. Use a public provider interface plus private provider implementation. The public repo owns contracts and integration points; a private deployment injects the model implementation. (session-settled: user-directed — chosen over committing model logic publicly: the feature is intended to support a business model)
- KTD2. Hide prediction by default behind backend and frontend flags. Disabled public builds must behave exactly like the current product so the feature can incubate privately.
- KTD3. Store prediction checkpoints as operational metadata on the run document or a related run-scoped document. This keeps `/runs/{runId}` as the dashboard's single read path while allowing multiple checkpoint records.
- KTD4. Public prediction records carry public-safe explanations only and avoid exposing proprietary prediction internals.
- KTD5. Keep model iteration outside the public schema by versioning providers and output contracts. The private provider can evolve independently as long as it returns the stable public `PredictionCheckpoint` shape.
- KTD6. Treat existing checked-in predictive SQL as pre-public sensitive material until audited. Before any public PR, either move it out of the public diff or replace it with contract-level documentation.

### High-Level Technical Design

```mermaid
flowchart TB
  A[GitHub Action telemetry] --> B[Backend ingest]
  B --> C[Firestore run samples]
  C --> D{Prediction enabled?}
  D -->|no| E[No-op provider]
  E --> F[/runs response without predictions]
  D -->|yes| G[Public provider interface]
  G --> H[Private provider package or service]
  H --> I[Private scoring and evaluation]
  I --> J[Public-safe checkpoint record]
  J --> K[Run-scoped prediction storage]
  K --> L[/runs response with prediction_checkpoints]
  L --> M[Hidden dashboard panel]
```

Public code sees only the provider interface and the returned checkpoint records.
Private code owns feature derivation, model invocation, scoring, and calibration.
The dashboard never computes prediction logic; it renders returned records when the backend says the feature is available.

### Public Prediction Contract

The public contract should be stable and intentionally generic:

| Field | Purpose | Public-safe constraint |
|---|---|---|
| `observation_window_s` | Checkpoint key such as 30, 60, or 180 | Required |
| `status` | `pending`, `ready`, `skipped`, or `error` | Required |
| `risk_level` | `low`, `elevated`, `high`, or `unknown` | No cutoff disclosure |
| `risk_score` | Optional normalized display score | May be bucketed or omitted |
| `confidence` | `low`, `medium`, `high`, or provider-defined public label | No calibration formula |
| `predicted_peak_rss_mb` | Optional predicted resource outcome | Rounded display value |
| `predicted_duration_s` | Optional predicted duration | Rounded display value |
| `signals` | Short public-safe explanations | Labels only, no importance/formulas |
| `provider_id` | Stable public provider identifier | Generic, not private model identifier |
| `model_version` | Version for support/debugging | Opaque version string |
| `created_at` | Prediction timestamp | Required for iteration |

### Assumptions

- The public repository will remain open or publicly accessible.
- A private repository, private module, or private service can hold proprietary provider code.
- The first implementation should favor clean boundaries over maximum model sophistication.
- The existing BigQuery ML files are design artifacts, not automatically safe to publish.

### Sequencing

1. Audit and quarantine sensitive predictive artifacts before public commit.
2. Add public data contracts and no-op/fake provider behavior.
3. Add backend storage and API response support for checkpoint records.
4. Add hidden dashboard rendering for public-safe prediction records.
5. Add release hygiene tests to prevent accidental publication of private logic.
6. Implement and iterate on private provider code outside this repo.

---

## Implementation Units

### U1. Sensitive Artifact Audit And Public Boundary Cleanup

- **Goal:** Prevent predictive model internals from being accidentally committed or pushed to the public repository.
- **Requirements:** R3, R4, R6, AE4, KTD6.
- **Dependencies:** None.
- **Files:** `backend/schema/predictive_reliability/`, `PREDICTIVE_RELIABILITY_IMPLEMENTATION.md`, `docs/plans/predictive-reliability-n-second-checkpoints.md`, `README.md`, `.gitignore`, `__tests__/frontend-metadata.test.ts`.
- **Approach:** Classify existing predictive SQL and docs into public-safe contract material vs private model material. Remove, relocate, or ignore proprietary SQL/model templates before any public PR. Keep only provider-contract documentation in public docs.
- **Execution note:** Start with the release-hygiene check so the public/private boundary is enforced before adding more feature code.
- **Patterns to follow:** Existing frontend metadata/static tests already protect public artifact expectations; extend that pattern for prediction secrecy checks.
- **Test scenarios:**
  - Public diff scan fails when public predictive artifacts contain model training, prediction SQL, scoring formulas, or private model identifiers.
  - Public docs allow provider-contract terms such as `prediction_checkpoints` and `provider_id`.
  - Public docs reject raw scoring cutoff phrases and concrete proprietary model references.
- **Verification:** Public-facing predictive docs contain only contract-level descriptions, and the test suite blocks accidental model disclosure.

### U2. Public Prediction Data Contract

- **Goal:** Add a stable backend model shape for prediction checkpoint records without embedding model behavior.
- **Requirements:** R5, R7, R9, R10, R12, AE1, AE3.
- **Dependencies:** U1.
- **Files:** `backend/internal/models/models.go`, `backend/internal/models/models_test.go`, `backend/internal/handlers/handlers_test.go`.
- **Approach:** Add a `PredictionCheckpoint` model and expose it from `RunResponse` as `prediction_checkpoints,omitempty`. Store only public-safe result fields. Preserve old response behavior when predictions are absent.
- **Patterns to follow:** `RunDoc` and `RunResponse` already use optional fields for process info and finished timestamps; mirror that compatibility style.
- **Test scenarios:**
  - Marshaling a run response without predictions omits `prediction_checkpoints`.
  - Marshaling multiple checkpoints preserves chronological records and optional fields.
  - Missing optional predicted values serialize without breaking consumers.
  - Unknown future fields from storage do not prevent current response construction.
- **Verification:** Backend model tests prove old and new response shapes are compatible.

### U3. Provider Interface And Disabled Defaults

- **Goal:** Create the public extension point for private prediction while keeping default deployments disabled.
- **Requirements:** R1, R5, R6, R7, R8, AE1, AE5.
- **Dependencies:** U2.
- **Files:** `backend/internal/predictor/`, `backend/internal/predictor/predictor_test.go`, `backend/main.go`, `backend/internal/handlers/handlers.go`, `backend/BUILD.bazel`, `backend/internal/handlers/BUILD.bazel`.
- **Approach:** Define a narrow predictor interface that accepts run telemetry context and returns public `PredictionCheckpoint` records. Provide no-op and fake implementations in public code. Wire config so absence of private provider settings means prediction is disabled.
- **Patterns to follow:** `backend/internal/exportqueue/queue.go` already isolates optional BigQuery export work behind an injected scheduler and skip-safe behavior.
- **Test scenarios:**
  - Disabled config selects the no-op provider.
  - Fake provider can return deterministic checkpoints for handler tests.
  - Provider errors are converted into public-safe error statuses and do not fail ingest.
  - Private provider import paths are not required for public builds or tests.
- **Verification:** Public backend builds and tests pass without any private dependency.

### U4. Checkpoint Scheduler And Storage

- **Goal:** Store provider-produced predictions once per configured checkpoint.
- **Requirements:** R7, R9, R10, AE2, AE5.
- **Dependencies:** U2, U3.
- **Files:** `backend/internal/storage/storage.go`, `backend/internal/storage/storage_test.go`, `backend/internal/handlers/handlers.go`, `backend/internal/handlers/handlers_test.go`, `backend/internal/predictor/`.
- **Approach:** After sample ingestion, evaluate configured checkpoint windows against stored sample elapsed times. Skip checkpoints already stored. Persist returned checkpoint records with run-scoped merge semantics so prediction updates do not overwrite samples or process metadata.
- **Patterns to follow:** `StoreSamples` appends samples to `runs/{runId}`, and `SetRunExportToBigquery` uses merge semantics for optional run metadata.
- **Test scenarios:**
  - A run below the first checkpoint performs no prediction work.
  - A run reaching a configured checkpoint invokes the provider once.
  - A duplicate ingest after a checkpoint skips an already stored prediction.
  - A provider failure stores or logs a public-safe error without blocking sample storage.
  - Prediction storage preserves existing samples, finished flags, and export flags.
- **Verification:** Backend handler/storage tests prove checkpoint idempotency and ingest resilience.

### U5. Hidden Dashboard Prediction Panel

- **Goal:** Render prediction checkpoint history only when the backend response and frontend feature gate allow it.
- **Requirements:** R1, R2, R4, R9, R10, R12, AE1, AE3.
- **Dependencies:** U2.
- **Files:** `frontend/public/runs/[runId].html`, `frontend/public/runs/demo.html`, `frontend/public/bpw-ui.css`, `frontend/public/demo-run.json`, `__tests__/demo-dashboard.test.ts`, `__tests__/run-dashboard-responsive.test.ts`, `__tests__/replay-accessibility.test.ts`.
- **Approach:** Add a compact prediction panel near the KPI strip that renders checkpoint cards or rows from `prediction_checkpoints`. Hide the entire panel when the feature flag is off or no predictions exist. Use neutral operational labels and avoid product-copy explanations in the dashboard surface.
- **Patterns to follow:** Current dashboard rendering handles optional GC, JIT, class loading, process info, and finished-run sections based on data presence.
- **Test scenarios:**
  - No predictions renders the old dashboard unchanged.
  - Feature flag off hides predictions even if test data includes them.
  - One ready checkpoint renders risk level, confidence, and rounded prediction values.
  - Multiple checkpoints render in ascending `observation_window_s` order.
  - Error or skipped checkpoint renders a compact status without leaking provider errors.
  - Mobile layout does not overflow when three checkpoints are present.
- **Verification:** Jest/static frontend tests cover absent, gated, single-checkpoint, and multi-checkpoint states.

### U6. Private Provider Integration Contract

- **Goal:** Document and enforce how private model providers attach without making private code a public dependency.
- **Requirements:** R5, R6, R8, R11, R12.
- **Dependencies:** U3, U4.
- **Files:** `README.md`, `PREDICTIVE_RELIABILITY_IMPLEMENTATION.md`, `backend/Makefile`, `.github/workflows/test-backend.yml`, `.github/workflows/deploy-backend.yml`.
- **Approach:** Document environment variables and build-time expectations at a generic level. Public CI should run with the no-op/fake provider. Private deployment can supply provider settings through secrets or a private build step without changing public source.
- **Patterns to follow:** BigQuery export is already optional and configured through env vars such as `BIGQUERY_EXPORT_DATASET`.
- **Test scenarios:**
  - Public CI runs without private provider credentials or modules.
  - Deployment config omits prediction env vars unless explicitly supplied.
  - Docs describe provider attachment without naming private repositories or proprietary prediction details.
- **Verification:** Public build and deployment config remain usable without private access.

### U7. Iteration And Commercial Rollout Guardrails

- **Goal:** Make future model iteration and paid packaging possible without schema churn or accidental public leakage.
- **Requirements:** R9, R10, R11, R12, AE4.
- **Dependencies:** U1, U2, U3, U6.
- **Files:** `PREDICTIVE_RELIABILITY_IMPLEMENTATION.md`, `docs/plans/predictive-reliability-n-second-checkpoints.md`, `README.md`, `__tests__/frontend-metadata.test.ts`.
- **Approach:** Add rollout guidance that distinguishes public OSS, private hosted, and enterprise provider modes. Require evaluation before enabling warnings. Keep model/version metadata opaque enough for support while allowing private iteration.
- **Patterns to follow:** Existing predictive docs already distinguish advisory resource-risk from guaranteed failures; retain that safety framing.
- **Test scenarios:**
  - Documentation includes disabled-by-default and advisory-risk language.
  - Documentation explains multiple checkpoints and confidence labels without exposing formulas.
  - Public metadata tests prevent private provider names and real model terms from entering public docs.
- **Verification:** Documentation supports commercial packaging decisions without revealing the proprietary implementation.

---

## Verification Contract

| Verification | Applies to | Expected signal |
|---|---|---|
| `npm test -- --runInBand` | U1, U2, U5, U7 | Public JS/static tests and backend contract fixtures pass. |
| `go test ./backend/...` | U2, U3, U4, U6 | Backend model, provider, storage, and handler behavior passes with no private provider dependency. |
| `node --check frontend/public/replay.js` and changed frontend scripts | U5 | Changed frontend JavaScript remains syntactically valid. |
| Public leak scan test | U1, U6, U7 | Public diff excludes proprietary prediction details and private deployment material. |
| Manual public-diff review | All units | Reviewer can verify the PR contains contracts and hidden surfaces only, not proprietary model implementation. |

---

## Definition of Done

- Prediction is disabled by default in public builds.
- Public API responses remain backward-compatible when predictions are absent.
- Public code has a provider interface, no-op/fake implementations, and tests that do not require private dependencies.
- Dashboard prediction rendering is hidden unless both data and feature gates allow it.
- Multiple checkpoint records can be stored and rendered without treating early predictions as final.
- Proprietary prediction details and private evaluation artifacts are not present in the public diff.
- Documentation explains provider attachment and commercial packaging at a contract level only.
- Abandoned experimental predictive files are removed, ignored, or moved outside the public repository before commit.
