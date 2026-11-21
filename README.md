# 🧠 Build Process Watcher

[![GitHub Marketplace](https://img.shields.io/badge/action-marketplace-blue?logo=github)](https://github.com/marketplace/actions/build-process-watcher)

<p align="center">
  <img src="frontend/public/performance.gif" alt="Performance Demo">
</p>

Monitor Java/Kotlin build processes (`GradleDaemon`, `GradleWorkerMain`, `KotlinCompileDaemon`) during CI builds. Track heap, RSS, garbage collection, JIT compilation, and class loading without injecting a Java agent or changing JVM launch arguments.

---

## ✨ Quick Start

**Unreleased development ref:** All examples below use verified commit [`88f0d0b85857dd71009cf827564fb33d75769214`](https://github.com/cdsap/build-process-watcher/commit/88f0d0b85857dd71009cf827564fb33d75769214). Its root action manifest and bundled action support the timeline inputs. The latest published release, `v0.7.0`, does not. See [release and migration notes](RELEASE_NOTES.md#unreleased).

### Local Mode (Artifacts Only)

```yaml
- uses: cdsap/build-process-watcher@88f0d0b85857dd71009cf827564fb33d75769214
```

Generates log files and charts as workflow artifacts.

### Remote Mode (Live Dashboard)

```yaml
- uses: cdsap/build-process-watcher@88f0d0b85857dd71009cf827564fb33d75769214
  with:
    remote_monitoring: 'true'
```

Data sent to cloud backend with live dashboard (24-hour retention).  
Dashboard URL shown in job output. GC (garbage collection) monitoring is always enabled.

### Optional Metrics Export to BigQuery

```yaml
- uses: cdsap/build-process-watcher@88f0d0b85857dd71009cf827564fb33d75769214
  with:
    remote_monitoring: 'true'
    export_to_bigquery: 'true'
```

This is not required for normal local or remote monitoring. Use it only when you want to collect run metrics in your own BigQuery dataset for longer-term analysis.

### Timeline Prediction (Experimental)

The latest release `v0.7.0` does not accept timeline inputs. This example pins a
verified timeline-capable commit; it is not a tagged release. See the
[forecast guide](docs/forecast-guide.md) for compatibility, replay media, and validation evidence.

```yaml
- uses: cdsap/build-process-watcher@88f0d0b85857dd71009cf827564fb33d75769214
  with:
    prediction_mode: 'predict'
    prediction_throttle_s: '20'
```

Prediction is disabled by default. Active modes automatically enable Remote Mode and do not enable `export_to_bigquery`. A selected mode requests a provider; it does not establish availability or successful inference.

| Mode | Model / behavior | Availability |
|------|------------------|--------------|
| `disabled` / omitted | No prediction request | Default; local monitoring remains possible |
| `forecast` | TimesFM time-series forecasts | Requires the configured hosted provider |
| `predict` | TabFM tabular prediction; distinct from TabPFN | Requires the configured hosted provider |
| `bqml-boosted` | Trained BigQuery ML boosted-tree forecasts | Requires the configured trained-model provider |
| `tabpfn` | TabPFN GPU inference on a VM | **TabPFN is disabled by default; available only when its VM/provider is available.** Selecting the input does not start the VM or guarantee forecasts. |

`prediction_throttle_s` is optional (default `20`, integer range `1–3600` seconds). It controls forecast issuance cadence in elapsed-time buckets, separately from collection `interval` and +10/+30/+60-second forecast horizons. Queueing and provider latency can delay delivery. See the [prediction guide](docs/prediction.md) and [migration notes](RELEASE_NOTES.md#migration).

---

## 📋 Inputs

| Input | Description | Default | Required |
|-------|-------------|---------|----------|
| `remote_monitoring` | Enable cloud dashboard | `false` | No |
| `run_id` | Custom run identifier | Auto-generated | No |
| `log_file` | Local log filename | `build_process_watcher.log` | No |
| `interval` | Polling interval (seconds) | `5` | No |
| `debug` | Enable debug logging | `false` | No |
| `disable_summary_output` | Disable GitHub Actions summary output | `false` | No |
| `export_to_bigquery` | Optional metrics export to BigQuery when Remote Mode finishes | `false` | No |
| `prediction_mode` | Request `disabled`, `forecast`, `predict`, `bqml-boosted`, or `tabpfn` | `disabled` | No |
| `prediction_throttle_s` | Process-forecast cadence in elapsed seconds for timeline modes | `20` | No |
| `freshness_diagnostics` | Add opt-in collection-to-dashboard timing telemetry; implies Remote Mode | `false` | No |

**Environment variables (for Remote Mode):** Set `BACKEND_URL` and `FRONTEND_URL` as env vars (e.g. from secrets) for custom URLs. If unset, default Cloud Run and dashboard URLs are used.

**BigQuery export is optional:** It is only for collecting metrics in BigQuery. Set `export_to_bigquery: 'true'` together with `remote_monitoring: 'true'` when you want that export. The backend service must be configured with `BIGQUERY_EXPORT_DATASET`; optional table overrides are `BIGQUERY_EXPORT_TABLE` and `BIGQUERY_EXPORT_PROCESSES_TABLE`.


**Prediction mode selection:** Set `prediction_mode` to `forecast`, `predict`, `bqml-boosted`, or `tabpfn` to request a timeline forecast mode. Values are lowercase; an empty input defaults to `disabled`. Invalid modes fail configuration. The `prediction_mode` output reports the selected request, not provider readiness.

**Prediction throttle:** Set `prediction_throttle_s` to control how often timeline modes issue forecasts (elapsed-seconds buckets shared by Cloud Tasks dedupe). Default is `20`. Valid range is `1`–`3600`.

**Freshness diagnostics are experimental and opt-in:** Set `freshness_diagnostics: 'true'` for a bounded live timing spike. Instrumented samples include collection, backend receipt, and backend storage timing; the run dashboard adds fetch/render timing, p50/p95 latency, sequence gaps, and a cross-host clock-skew warning. The option enables Remote Mode but does not enable prediction or BigQuery export.

Timeline modes (`forecast`, `predict`, `bqml-boosted`, `tabpfn`) enable Remote Mode. They do not imply BigQuery export. Set `export_to_bigquery: 'true'` separately when export is needed.

When run data contains public-safe `process_forecasts`, the dashboard renders timeline forecast overlays. The public contract intentionally omits non-public implementation details, training data, and service endpoints.

---

## 🧭 Behavior Matrix

| Mode | Debug | Summary | Debug logs in artifacts | Notes |
|------|-------|---------|-------------------------|-------|
| Local | `false` | ✅ (default) | ❌ | CSV/SVG/log generated locally. |
| Local | `true` | ✅ (default) | ✅ | Copies `backend_debug*.log` and `script_debug*.log` into artifacts. |
| Local | `any` | ❌ (`disable_summary_output: true`) | depends on debug | Summary suppressed when disabled. |
| Remote | `false` | ✅ (default) | ❌ | Dashboard URL shown; local artifacts if log exists. |
| Remote | `true` | ✅ (default) | ✅ | Debug logs copied into artifacts. |
| Remote | `any` | ❌ (`disable_summary_output: true`) | depends on debug | Summary suppressed when disabled. |

---

## 🧪 Run CI Locally with act

You can execute the local CI workflow using `act`:

```bash
act -W .github/workflows/test-action-local.yml
```

To run a single job:

```bash
act -W .github/workflows/test-action-local.yml -j local-mode
```

---

## 📊 Outputs

### Local Mode
- `build_process_watcher.log` - Raw memory data
- `memory_usage.svg` - SVG chart
- `gc_time.svg` - GC time chart
- `jit_compilation.svg` - JIT compiled methods chart when JIT metrics are available
- `class_loading.svg` - Classes loaded chart when class-loading metrics are available
- `build_process_watcher.json` - Replay/Compare-compatible data export
- `build_process_watcher.csv` - Tabular metrics export
- GitHub Actions job summary with Mermaid chart

### Remote Mode
- Live dashboard URL (in job output)
- Data retention: 24 hours
- Real-time process monitoring
- GC time metrics
- JIT compilation totals and interval activity when `jstat -compiler` is supported
- Class-loading totals and classes-per-second activity when `jstat -class` is supported
- GitHub Actions job summary (unless `disable_summary_output: 'true'` is set)

---

## 📸 Screenshots

### Interactive Dashboard
![SVG Chart Example](frontend/public/svg-chart-example.png)

The dashboard shows:
- Memory usage over time for all monitored processes
- Individual process metrics (RSS, Heap Used, Heap Capacity)
- Aggregated memory consumption
- Interactive charts with Plotly.js
- Conditional JIT and class-loading panels; older runs keep the existing layout

### JIT and Class-Loading Metrics

The watcher calls the JDK's external `jstat` tool at the normal monitoring interval. It stores cumulative compiler and class-loading counters and derives activity rates between actual observations. Missing, unsupported, or failed counters are recorded as `null`; memory and GC collection continue independently.

`jstat` availability and attach permissions vary by JVM and environment. Compilation time is compiler-thread elapsed time and should not be treated as process CPU time or compared as a JVM-independent performance verdict. To measure local collection cost for a representative JVM, run `scripts/benchmark-jstat-metrics.sh <pid>`.

### GitHub Actions Summary
![Mermaid Diagram Example](frontend/public/mermaid-diagram-example.png)

The job summary includes:
- Combined Mermaid flowchart showing RSS, heap, GC, JIT compilation, and class-loading progression at representative checkpoints
- Aggregated RSS and GC totals at each checkpoint
- Per-process statistics (max, average, final measurements)
- Timeline of monitoring session

---

## 📂 Replay & Compare Runs

The dashboard lets you:

- **Replay a run** – Upload an exported JSON file to replay memory, GC, JIT, and class-loading charts offline.
- **Compare runs** – Upload two JSON files to compare two runs in overlay or side-by-side views with a shared timeline.

<p align="center">
  <img src="frontend/public/reply.gif" alt="Replay Demo" width="600"><br><br>
  <img src="frontend/public/compare.gif" alt="Compare Demo" width="600">
</p>

**Using without Remote Mode:** You don't need Remote Mode to use Replay and Compare. With Local Mode, the action generates JSON files in the workflow artifacts. Download the JSON from your artifacts and upload it to [Replay](https://process-watcher.web.app/replay.html) or [Compare](https://process-watcher.web.app/compare.html). You can also open these HTML files locally in your browser.

---

## 🏗️ Architecture

- **Frontend**: Firebase Hosting (static dashboard)
- **Backend**: Google Cloud Run (Go API)
- **Database**: Firestore (24-hour TTL)

---

## 📝 License

MIT
