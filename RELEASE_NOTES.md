# Unreleased

Timeline prediction requests per-process heap/RSS forecasts through `forecast` (TimesFM), `predict` (TabFM), `bqml-boosted` (BigQuery ML boosted trees), or `tabpfn` (TabPFN GPU). Prediction is experimental, advisory, and disabled by default. Active modes enable Remote Mode without enabling finished-run BigQuery export. TabPFN is disabled by default and requires an available VM/provider; selecting its input does not start the VM.

The README and homepage examples use verified development commit [`88f0d0b85857dd71009cf827564fb33d75769214`](https://github.com/cdsap/build-process-watcher/commit/88f0d0b85857dd71009cf827564fb33d75769214), whose root `action.yaml` and bundled `dist/index_with_backend.js` support `prediction_mode` and `prediction_throttle_s`. This is not a published release. The latest published release, `v0.7.0`, predates those inputs. See the [prediction guide](docs/prediction.md) for mode availability and cadence (default 20 seconds; integer range 1–3600).

## Migration

Replace the former `predictive_reliability` input with a deliberate `prediction_mode` choice using the development ref above. The current backend rejects the former parameter. This changes behavior: new timeline forecasts use optional `process_forecasts`, while historical reliability checkpoints remain legacy data. Request `export_to_bigquery: 'true'` independently if finished-run metrics export is needed. Old JSON artifacts remain readable without forecasts.

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
