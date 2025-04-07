# 🧠 Build Process Watcher

[![GitHub Marketplace](https://img.shields.io/badge/action-marketplace-blue?logo=github)](https://github.com/marketplace/actions/build-process-watcher)

**Build Process Watcher** is a GitHub Action to monitor the memory usage of Java/Kotlin daemons (`GradleDaemon`, `GradleWorkerMain`, and `KotlinCompileDaemon`) during your CI builds.

It tracks heap and RSS usage over time and generates a detailed log and optional SVG chart. Perfect for debugging OOM kills, analyzing memory trends, or identifying runaway daemons.

---

## ✨ Quick Start (One-liner)

Use this if you want a clean setup:

```yaml
- uses: cdsap/build-process-watcher@v0.1
```
✅ Automatically starts memory monitoring and runs cleanup at the end  
⚠️ Cleanup won't run if the job is killed by OOM or cancellation before the action step starts

## 🛠️ Manual Mode (Debug / Safe Cleanup)
Use this if you want guaranteed cleanup, even if the build fails:

```yaml
steps:
  - uses: cdsap/build-process-watcher/start@v0.1
    with:
      interval: 5

  - run: ./gradlew build

  - uses: cdsap/build-process-watcher/cleanup@v0.1
    if: always()
```
✅ More verbose  
✅ Ensures cleanup runs at the end of the job (unless the entire runner crashes)

## 📥 Inputs
* `interval`: Polling interval in seconds (default 5s)

## 📦 Output
* java_mem_monitor.log: raw memory data (RSS + heap)

* memory_usage.svg: optional SVG memory chart

* GitHub Actions job summary (Mermaid chart + per-process stats)
