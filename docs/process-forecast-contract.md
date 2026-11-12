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
metrics observed for eligible processes and matches actuals at exactly the target
sample timestamp; it does not interpolate. This spike does not imply that any
provider currently emits this contract.
