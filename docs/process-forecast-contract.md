# Process memory forecast spike contract

The optional `process_forecasts` array on a run is a provisional, additive UI
contract for synthetic fixtures and provider coordination. Existing artifacts do
not need it. Each entry describes one forecast issuance for one observed process
and metric:

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
with dashed prediction traces from each issuance. Table actuals use the nearest
sample within ±10s of the target timestamp (not interpolation). This spike does
not imply that any provider currently emits this contract.

## Live path (v1)

When `prediction_mode` is a timeline mode (`forecast`, `predict`, `bqml-boosted`,
`tabpfn`), the public backend may call the matching private provider path
(`POST /forecast`, `/tabpredict`, `/bqml-boosted`, or `/tabpfn`) and append
returned issuances to `process_forecasts`. Reliability checkpoints are not
written for these modes. Private implementations vary (TimesFM, TabFM, BQML
boosted trees, TabPFN) and may fall back to last-value for thin series or
provider failures. Horizons are +10/+30/+60 seconds on the sample clock for
`GradleDaemon` and `KotlinCompileDaemon` heap/RSS.
