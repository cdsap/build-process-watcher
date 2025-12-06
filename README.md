# 🧠 Build Process Watcher

[![GitHub Marketplace](https://img.shields.io/badge/action-marketplace-blue?logo=github)](https://github.com/marketplace/actions/build-process-watcher)

Monitor memory usage of Java/Kotlin build processes (`GradleDaemon`, `GradleWorkerMain`, `KotlinCompileDaemon`) during CI builds. Track heap and RSS usage, generate charts, and visualize data in real-time dashboards.

---

## ✨ Quick Start

### Local Mode (Artifacts Only)

```yaml
- uses: cdsap/build-process-watcher@0.3
  with:
    remote_monitoring: 'false'
```

Generates log files and charts as workflow artifacts.

### Remote Mode (Live Dashboard)

```yaml
- uses: cdsap/build-process-watcher@0.3
  with:
    remote_monitoring: 'true'
```

Data sent to cloud backend with live dashboard (3-hour retention).  
Dashboard URL shown in job output.

---

## 📋 Inputs

| Input | Description | Default | Required |
|-------|-------------|---------|----------|
| `remote_monitoring` | Enable cloud dashboard | `false` | No |
| `backend_url` | Custom backend URL | Default Cloud Run URL | No |
| `run_id` | Custom run identifier | Auto-generated | No |
| `log_file` | Local log filename | `build_process_watcher.log` | No |
| `interval` | Polling interval (seconds) | `5` | No |
| `debug` | Enable debug logging | `false` | No |
| `collect_gc` | Enable garbage collection monitoring (requires Java processes) | `false` | No |

---

## 📊 Outputs

### Local Mode
- `build_process_watcher.log` - Raw memory data
- `memory_usage.svg` - SVG chart
- GitHub Actions job summary with Mermaid chart

### Remote Mode
- Live dashboard URL (in job output)
- Data retention: 3 hours
- Real-time process monitoring

---

## 📸 Screenshots

### Interactive Dashboard
![SVG Chart Example](frontend/public/svg-chart-example.png)

The dashboard shows:
- Memory usage over time for all monitored processes
- Individual process metrics (RSS, Heap Used, Heap Capacity)
- Aggregated memory consumption
- Interactive charts with Plotly.js

### GitHub Actions Summary
![Mermaid Diagram Example](frontend/public/mermaid-diagram-example.png)

The job summary includes:
- Mermaid flowchart showing process memory progression
- Per-process statistics (max, average, final measurements)
- Timeline of monitoring session

---

## 🏗️ Architecture

- **Frontend**: Firebase Hosting (static dashboard)
- **Backend**: Google Cloud Run (Go API)
- **Database**: Firestore (3-hour TTL)

---

## 📝 License

MIT
