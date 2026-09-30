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
