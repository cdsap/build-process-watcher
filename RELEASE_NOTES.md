# Unreleased

## v0.8.0 (unreleased)

Planned next release for timeline forecasts. This is a release-preparation target, not an existing tag advertised for use. Examples currently use the verified development ref below. This work does not authorize publication or deployment.

## Timeline forecasts and configuration

- The root action replaces `predictive_reliability` with an explicit `prediction_mode`: `disabled` (default), `forecast`, `predict`, `bqml-boosted`, or `tabpfn`. This is a behavior change, not a mechanical rename or an automatic migration of the former boolean.
- Active modes enable Remote Mode and request timeline forecasts in `process_forecasts`. Historical reliability records remain legacy data; dashboard compatibility with old artifacts does not preserve the retired action input. The current backend rejects the former query parameter.
- `prediction_throttle_s` controls forecast issuance cadence in elapsed seconds, defaults to `20`, and accepts integers from `1` to `3600`. Invalid modes or cadence values fail configuration.
- Active modes no longer enable finished-run BigQuery export implicitly. Set `export_to_bigquery: 'true'` independently when needed; the backend must have `BIGQUERY_EXPORT_DATASET` configured. With prediction disabled, export also requires explicit Remote Mode.
- Action outputs report the selected `prediction_mode`, `prediction_throttle_s`, and independent `export_to_bigquery` request. Selecting a mode does not report provider readiness.
- Prediction is experimental, advisory, and disabled by default. It is not an OOM, timeout, or build-failure guarantee. TabPFN additionally requires an available VM and is disabled by default; selecting the mode does not provision or start that VM.
- Prediction examples apply only to the root action. `/start` and `/composite` currently expose only `interval`.

See the [before/after migration YAML](README.md#migration-from-predictive_reliability). The v0.7.0 notes below remain historical.

## Migration

Replace the former `predictive_reliability` input with a deliberate `prediction_mode` choice using the development ref above. The current backend rejects the former parameter. This changes behavior: new timeline forecasts use optional `process_forecasts`, while historical reliability checkpoints remain legacy data. Request `export_to_bigquery: 'true'` independently if finished-run metrics export is needed. Old JSON artifacts remain readable without forecasts.


## Release validation

Snapshot checked 2026-11-21. Source support and an available development artifact do not establish release publication, hosted provider readiness, or deployment.

| Gate | Evidence / status |
| --- | --- |
| Source commit | [`88f0d0b85857dd71009cf827564fb33d75769214`](https://github.com/cdsap/build-process-watcher/commit/88f0d0b85857dd71009cf827564fb33d75769214): timeline-mode inputs/outputs in `action.yaml`, configuration in `src/index_with_backend.ts` and `src/monitoring_features.ts`. |
| Development artifact/ref | `cdsap/build-process-watcher@88f0d0b85857dd71009cf827564fb33d75769214` exists. Its manifest selects `dist/index_with_backend.js` and `dist/cleanup.js`; the committed main bundle reads the timeline inputs, writes their outputs, defaults to disabled/20 seconds, and keeps export independent. Manifest and main bundle also retrieved from GitHub at that exact ref. This is the ref used by README and homepage examples. |
| Published artifact/ref | Published `v0.7.0` resolves to `28e5cf911500151e0ec2eb01bc13d6c8a0faa37f` and exposes the former reliability input. It is not a timeline release. Publication of the planned v0.8.0 is pending validation; no v0.8.0 tag is advertised in examples. |
| Documentation | README, homepage source, migration guidance, and these draft notes are prepared for the development ref. Their merge/publication is a separate gate; they do not certify deployed documentation. |
| Deployment | Backend/provider availability and hosted frontend deployment have not been validated by this documentation change. No publication or deployment is performed or authorized here. |

Before replacing the development ref with a release tag:

1. Record the final source SHA and test results; verify the release commit contains both the manifest and built main/post bundles, including the scripts they execute.
2. After separately authorized publication, resolve the published tag to that SHA and inspect the manifest and bundles **at the tag**, including timeline input/output support and independent export behavior.
3. Update README and homepage examples together to that verified tag. Record the documentation commit and merge/publication status separately from the action release.
4. Record backend/provider validation and frontend deployment revision/status separately; verify the hosted homepage after any separately authorized deployment.

---

# v0.7.0

Released 2026-09-30.

## Added

- Added opt-in predictive reliability checkpoints to the public action contract and dashboard.
- Added checkpoint markers to the live run memory graph, with risk, confidence, forecast, and signal details in hover content.
- Added experiment-oriented dashboard presentation for multi-metric build analysis.

## Changed

- Refactored prediction checkpoint evaluation, storage integration, and remote-provider boundaries without exposing provider internals.
- Refactored monitor-log parsing into a shared domain helper used by chart, CSV, and JSON report generation.
- Updated action runtime-path handling and Windows execution behavior.
- Updated the public action snippets to use `cdsap/build-process-watcher@v0.7.0`.

## Release scope

Predictive reliability remains opt-in and advisory. Existing runs without prediction checkpoints retain their legacy dashboard and report behavior.
