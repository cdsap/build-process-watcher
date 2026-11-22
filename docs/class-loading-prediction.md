# Class-loading activity prediction experiment

Status: development implementation; no released action tag is claimed here.

Use the root action at a verified commit containing this feature with:

```yaml
with:
  prediction_mode: tabpfn
  prediction_target: class_loading
  prediction_throttle_s: '20'
```

`prediction_target` defaults to `memory`. Class loading is only supported with
`tabpfn`; unsupported combinations fail validation. Prediction automatically
uses Remote Mode. Finished-run BigQuery export is independent and optional.
Cadence defaults to 20 elapsed seconds (integer range 1–3600), separate from the
sampling interval and fixed +60-second forecast horizon. Scheduling and inference
may delay delivery; a cadence is not a delivery-time guarantee.

TabPFN is disabled by default. Its VM, provider, and separate fitted activity
model must be available. Selecting this target does not start the VM or train a
model. Missing usable history and unavailable providers are explicit results;
neither is a zero-class prediction. No new collector command is needed.

## Additive response

Runs may contain `prediction_target` and `process_activity_forecasts`. Old runs
without these fields remain valid and default to memory behavior. Existing
`process_forecasts` and `value_mb` retain their memory meaning.

Each activity issuance has `process_name`, `pid`, `metric: classes_loaded`,
`created_at_ms` on the sample clock and `status`. Successful results include
`origin_value_count`, one point with `target_at_ms = created_at_ms + 60000`,
`predicted_delta_count`, and `predicted_total_count` (origin + delta).
All values are class counts. Optional method, model version and latency fields
are descriptive metadata. Status is `ready`, `insufficient_history`, `unavailable`,
or `fallback`; unavailable/short-history results omit points. Fallbacks must be
marked and never represented as successful TabPFN inference. The first adapter
uses unavailable status rather than fabricating a fallback. Model output is
clamped to nonnegative counts before public display.

Activity is currently scoped to `GradleDaemon` and `KotlinCompileDaemon`, with
independent PID series within a run. It requires at least 60 seconds of clean
class-counter history. Missing class counters, resets, invalid timestamp order,
and large sampling gaps do not become numeric predictions. Optional JIT/GC
counters are not required for memory and class collection to continue.

## Reading the panel

The separate **Class-loading activity** panel shows actual cumulative classes as
a solid line and the issued +60-second total as a dashed segment. The callout
reports the additional class count over that horizon. Axes use classes, never MB.
Live follows samples; Replay and its timeline expose only issuances at or before
the selected sample-clock time. Latest, Last 3, and All choose issuance history.
Original targets stay fixed when the replay position changes.

Observed increase and signed error (prediction minus observed increase) use the
nearest same-process observation within ±5 seconds of the +60-second target,
and only observations visible at the replay position. Ties favor the earlier
sample. Missing actuals and counter resets remain pending. Collection gaps over
15 seconds break actual lines and prevent comparisons across missing history.
The recent-issuance table retains completed comparisons while newer predictions
are pending. Status, model, latency, and fallback labels distinguish what happened. Counts
are rounded only for display.

Declining loading activity is not proof that the JVM is warmed up. There is no
warm-up classification, JIT prediction, automatic tuning, or OOM verdict here.

## Validation gates

Public contract/UI tests and simulated HTTP tests verify integration only.
A separate held-out evaluation must compare actual model inference with both
zero-additional-classes and recent-rate baselines, reporting count errors and
process/stage breakdowns. A real end-to-end run with the private GPU model must
produce a +60-second activity point before the experiment is considered fully
validated. Neither fixture output nor a selected mode proves provider readiness
or model quality. No quality improvement is claimed by this implementation.
