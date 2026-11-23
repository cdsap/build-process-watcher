# Public code cleanup spike

Date: 2026-11-23. Baseline: `73a47df40d0684f4dee3de3ea66b3588f0812b13`.

## Decision

Remove confirmed unreachable implementation first. Keep public JavaScript exports, stored run shapes, older uploaded reports, mode/target validation, unavailable states, and default-disabled optional features. Follow with separate changes to replay ownership and release checks. Avoid a large dashboard rewrite.

## Review coverage and evidence

The review mapped the action entry points (`action.yaml`, `src/index_with_backend.ts`, `src/cleanup.ts`), dashboard/Replay/compare script loading, backend server composition and prediction scheduling, tests, scripts, and workflow references. Candidate-level inspection covered the files below. This is a structural spike with focused source review, not a claim that every line or external consumer was audited.

Six review lenses ran sequentially: reuse, quality, efficiency, test value, comments, and structure. Evidence included TypeScript AST symbol references, repository-wide searches including HTML and workflows, Go callers/Bazel visibility, and recent change history. Export aliases were resolved before judging symbols unused; raw occurrence counts initially produced false positives for active action helpers.

Historical co-change identifies `prediction-view.js` and its tests as one maintained boundary (26 shared commits in the inspected history), and highlights shared state between dashboard controllers and renderers. Those counts are leads, not proof that files should be merged.

Baseline checks passed: 317 Jest tests, TypeScript checking, and all 15 Bazel test targets. No npm lint script is configured.

## Delete

### PUB-1 — Uncalled private dashboard helpers — implemented

Locations at baseline: `frontend/public/prediction-view.js:13–172,971`, `frontend/public/compare-shared.js:1062,1481`, `__tests__/playback-clock.test.ts:5`.

Remove the retired checkpoint-selection, risk-marker, evolution-row, and hidden forecast-table renderer functions and their exclusively used helpers/constants. Remove the uncalled comparison delta formatter and UI updater, and the unused `loadClock` test loader. None is exported or registered as a callback. AST reference checks and full-source searches found no callers after following the unused helper chains.

Keep `elapsedByTimestamp` in compare: the active replay-controls callback still reads it. Keep exported checkpoint normalization/marker shims and report aggregation helpers. An unused function does not make adjacent state or compatibility exports unused.

No test case is removed here. The active playback tests continue to use `loadClockDirect`. Existing prediction retirement, class-loading, memory, and compare tests remain unchanged.

### PUB-2 — Retired backend evaluator with no production consumer — implemented

Locations: `backend/internal/prediction/checkpoint_evaluator.go` and its test; matching entries in `backend/internal/prediction/BUILD.bazel`.

The evaluator constructor, repository interface, and no-op methods are referenced only by their own no-op test. Retirement occurred in commit `579670e` (#351); current server/scheduler composition uses `ForecastEvaluator`. The package is under Go `internal` and restricted by Bazel visibility.

Remove both files and their explicit Bazel source entries. The deleted test guarded only the behavior of this unreachable implementation; it neither exercised scheduling nor protected persisted checkpoint decoding. Active forecast evaluator tests and frontend legacy-run/retirement tests remain. Leave storage fields, JSON compatibility and shared predictor types intact.

## Refactor

### PUB-3 — Give prediction replay one clock owner — follow-up, medium risk

Locations: `frontend/public/prediction-view.js` (`bindProcessForecastView`, `bindActivityView`), `frontend/public/playback-clock.js`, `frontend/public/replay-controls.js`, and `frontend/public/replay.js`.

Memory prediction replay uses the shared playback clock, while activity replay maintains a separate `setInterval`, cursor, speed and full-panel redraw. Shared toolbar markup does not give these paths shared playback semantics. Re-rendering the entire panel also replaces controls and charts during playback; performance impact has not been measured.

Move activity transport scheduling onto the existing clock, keeping count-series preparation and reset-aware matching separate from memory metrics. Preserve `seekTo` semantics used by uploaded Replay, issuance revelation, pause/reset, live updates, focus, and listener/timer disposal. Verify with controlled-clock tests and dashboard/upload browser tests before deleting the extra timer. Do not merge class counts into MB data paths.

## Encode as a test

### PUB-4 — Guard the checked-in action artifact — follow-up, high priority

Locations: `build.sh`, `.github/workflows/test-action.yml`, `dist/`, `__tests__/bundled-prediction-target.test.ts`.

GitHub Actions executes the committed bundle, not TypeScript source. The recent stale validation failure is already guarded for prediction mode/target behavior, but that single module check cannot establish parity of the whole action and cleanup bundles. Build validation must detect source changes whose generated artifacts were not committed.

Use a clean lockfile install, build, and compare tracked action artifacts. Establish reproducibility first: a symlink to dependencies in another checkout changes ncc module IDs and is unsuitable for this check. Reconcile existing generated drift in its own commit. Preserve the shipped-code regression test and both action entry points.

Acceptance: intentionally change an action behavior without regenerating `dist`; the artifact gate fails, while an unchanged clean rebuild passes. Do not edit generated bundles manually to satisfy the gate.

### PUB-5 — Make mode/target contracts agree across boundaries — follow-up

Locations: `src/monitoring_features.ts`, `monitor_with_backend.sh`, `action.yaml`, `backend/internal/handlers/auth_options.go`, and mode-boundary tests.

Allowed combinations appear at several trust boundaries and in user-facing descriptions. Keep validation at each boundary; removing it as duplication would weaken error handling. Make the existing action, shell and backend matrix tests use an agreed fixture, including defaults, rejected combinations, throttle bounds, and export independence. This is a test contract, not a new runtime framework or provider catalog.

## Retain or investigate separately

- `loadRunDataLegacy` is reachable for static/demo loading and the dependency fallback. Its name is not evidence of non-use.
- `experiment-layout.js` and `bpw-experiment.css` are loaded by live, demo and Replay pages. Keep compare classic-only.
- `reply.gif` and `replay.gif` have identical SHA-1 content, but `reply.gif` is linked by the homepage and README. No local caller was found for `replay.gif`; removing a published asset needs an external-link/redirect decision.
- Preserve parser optional-field handling, unavailable/fallback distinctions, no-op controllers for missing DOM hosts, and legacy JSON fields. These encode compatibility or failure behavior.
- Keep directive, protocol, accessibility and compatibility comments. No broad comment or snapshot-test purge is justified by this spike.
- Baseline root worktree changes were excluded by using an isolated branch.

## Sequence and completion checks

1. Review this small deletion change; run Jest, TypeScript, JS syntax checks, all Bazel tests and the server build, plus browser tests.
2. Add the clean artifact-parity gate and align contract fixtures in separate PRs.
3. Refactor replay ownership after its clock/focus/disposal checks are in place.

The first change preserves exports, routes, artifact schemas and rendered behavior. It does not deploy anything. Larger removals or API deprecations need their own reviewed migration scope.
