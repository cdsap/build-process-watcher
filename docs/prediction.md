# Timeline prediction (experimental)

Prediction is disabled by default and remains an advisory signal for triage, not a guaranteed OOM, timeout, or build-failure outcome. Do not use it as a production decision or reliability guarantee.

Use the root action at the [verified development ref in the README](../README.md#timeline-prediction-experimental). These inputs are unreleased; the published `v0.7.0` does not support them. See [release and migration notes](../RELEASE_NOTES.md#unreleased).

## Mode choice

| Mode | Model / behavior | Availability |
|------|------------------|--------------|
| `disabled` / omitted | No prediction request | Default; local monitoring remains possible |
| `forecast` | TimesFM time-series forecasts | Requires the configured hosted provider |
| `predict` | TabFM tabular prediction; distinct from TabPFN | Requires the configured hosted provider |
| `bqml-boosted` | Trained BigQuery ML boosted-tree forecasts | Requires the configured trained-model provider |
| `tabpfn` | TabPFN GPU inference on a VM | **TabPFN is disabled by default; available only when its VM/provider is available.** Selecting the input does not start the VM or guarantee forecasts. |

Active modes automatically enable Remote Mode. They do not enable finished-run BigQuery metrics export: request `export_to_bigquery: 'true'` separately when needed. A provider's use of BigQuery does not enable that export.

The `prediction_mode` output reports the selected request, not provider readiness or successful inference. Forecasts can be absent while eligible history accumulates, when a provider is unavailable, or while work is queued. A returned forecast may use a last-value fallback; absence of results does not guarantee fallback data.

## Cadence

`prediction_throttle_s` defaults to `20` and accepts integer seconds from `1–3600`. It controls forecast issuance cadence in elapsed-time buckets. The output reports the selected cadence, not a delivery guarantee.

Collection `interval` controls sample polling. Forecast horizons (+10/+30/+60 seconds) describe future targets relative to an issuance. Neither is the issuance cadence. Queueing and provider latency can delay delivery.

## Reading forecasts

The default `prediction_target: memory` can add optional `process_forecasts` for eligible Gradle/Kotlin daemon heap-used and RSS samples, in MB. It does not predict every monitored process or GC/JIT/class-loading metrics. The dashboard overlays actual memory samples with dashed forecast traces. Issuance time identifies when a prediction was made; target times stay fixed when replay advances.

The unreleased opt-in combination `prediction_mode: tabpfn` and
`prediction_target: class_loading` instead requests additional classes over +60
seconds for `GradleDaemon` and `KotlinCompileDaemon`. It uses a separate count-based
contract and panel in the dashboard and uploaded Replay. Other modes retain the
memory target. TabPFN remains disabled by default and requires an available VM
and fitted activity model; selecting this target does not start the VM.
Count forecasts remain experimental; successful inference does not establish
accuracy or prove that JVM warm-up is complete.
See the [class-loading experiment](class-loading-prediction.md).

Use Live/Replay to inspect the timeline and Latest/Last 3/All to choose issuance history. Check the observed method and fallback indication rather than inferring model success from the requested mode. Accuracy summaries depend on matched actual samples and their counts; they are not an accuracy guarantee. See the [forecast data contract](process-forecast-contract.md) for fields and timestamp semantics. Historical artifacts without forecasts or optional timing fields remain valid.
