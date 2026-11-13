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
      ]
    }
  ]
}
```

`process_name` and `pid` match sample `Name` and `PID`; `metric` is `heap`
(`HeapUsed`) or `rss` (`RSS`). Values are MB, and times are Unix milliseconds
on the same clock as sample `Timestamp`. Points must target the creation time
or later. Keep earlier entries when adding later forecasts. The UI only displays
metrics observed for eligible processes. The chart overlays solid actual samples
with dashed prediction traces from each issuance. Table actuals use the nearest
sample within ±10s of the target timestamp (not interpolation). This spike does
not imply that any provider currently emits this contract.

## Live path (v1)

When `prediction_mode=forecast`, the public backend may call the private
provider `POST /forecast` and append returned issuances to `process_forecasts`.
Reliability checkpoints are not written for forecast mode. The private v1
implementation uses BigQuery `AI.FORECAST` (TimesFM) with a last-value fallback
for thin series or provider failures. Horizons are +10/+30/+60 seconds on the
sample clock for `GradleDaemon` and `KotlinCompileDaemon` heap/RSS.
