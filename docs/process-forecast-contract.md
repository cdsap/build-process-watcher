# Process memory forecast contract

The optional `process_forecasts` array is the additive contract used by the
implemented timeline path. Existing artifacts do not need it. See the
[forecast guide](forecast-guide.md) for the verified action ref, synthetic example,
and release limitations. Each entry describes one forecast issuance for one
observed process and metric:

```json
{
  "process_forecasts": [
    {
      "process_name": "GradleDaemon",
      "pid": "1234",
      "metric": "heap",
      "created_at_ms": 1700000000000,
      "points": [
        { "target_at_ms": 1700000060000, "value_mb": 512 }
      ],
      "method": "ai_forecast",
      "model_version": "bq-ai-forecast-timesfm-v1",
      "latency_ms": 1200,
      "provider_latency_ms": 1100,
      "inference_latency_ms": 950,
      "fallback": false
    }
  ]
}
```

Optional timing fields (legacy runs may omit them):

- `latency_ms`: end-to-end public backend → private provider round trip
- `provider_latency_ms`: private endpoint wall time
- `inference_latency_ms`: model-only time when known (BigQuery / TabPFN GPU)
- `fallback`: true when the issuance used last-value instead of the primary model

`process_name` and `pid` match sample `Name` and `PID`; `metric` is `heap`
(`HeapUsed`) or `rss` (`RSS`). Values are MB, and times are Unix milliseconds
on the same clock as sample `Timestamp`. Points must target the creation time
or later. Keep earlier entries when adding later forecasts. The UI only displays
metrics observed for eligible processes. The chart overlays solid actual samples
with dashed prediction traces from each issuance. Actual-value matching uses
the nearest sample within ±10s of the target timestamp (not interpolation); an equally close
sample before the target wins over one after it. Unmatched actuals remain pending.
The chart hover and horizon summaries use this matching rule.

The UI accepts observed `GradleDaemon`, `GradleWorkerMain`, and
`KotlinCompileDaemon` metrics, with numeric or string PIDs normalized to strings.
Invalid timestamps, negative/non-numeric values, targets before issuance, and
unobserved process/metric combinations are ignored. Missing `process_forecasts`
and missing timing fields are valid legacy data, not zero latency or zero memory.
`method`, `model_version`, and timing/fallback metadata may be absent. Do not infer
model execution from the selected mode alone.

## Live path (v1)

When `prediction_mode` is a timeline mode (`forecast`, `predict`, `bqml-boosted`,
`tabpfn`), the public backend may call the matching private provider path
(`POST /forecast`, `/tabpredict`, `/bqml-boosted`, or `/tabpfn`) and append
returned issuances to `process_forecasts`. Reliability checkpoints are not
written for these modes. Private implementations vary (TimesFM, TabFM, BQML
boosted trees, TabPFN) and may fall back to last-value for thin series or
provider failures. Horizons are +10/+30/+60 seconds on the sample clock for
`GradleDaemon` and `KotlinCompileDaemon` heap/RSS.

Replay reveals each issuance at `created_at_ms` and preserves its origin and
original target timestamps/values. Latest draws one revealed issuance, Last 3 up
to three, and All all revealed issuances. Orange markers retain revealed issuance
history in every setting. Passing the final target marks an issuance expired;
scrubbing never moves its +10/+30/+60 targets. Finished runs open Replay.

Earlier spike and reliability plans under `docs/plans/` are historical design
records, not current consumer instructions. The timeline path does not require
reliability checkpoint windows. Provider availability remains a separate runtime
condition; a stored last-value fallback is not successful primary model inference.

## Class-loading activity target (unreleased)

`prediction_target: class_loading` is an additive TabPFN-only experiment. It uses
`process_activity_forecasts` with count-based deltas and totals, never `value_mb`.
Missing targets default to memory. See [the activity contract](class-loading-prediction.md)
for statuses, +60-second timing, replay, and the required VM/model availability.
