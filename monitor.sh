#!/bin/bash

set -euo pipefail  # safer scripting: exit on error, unset vars, pipe errors

INTERVAL="${1:-5}"
PATTERNS=("GradleDaemon" "KotlinCompileDaemon" "GradleWorkerMain")
LOG_FILE="build_process_watcher.log"
PID_FILE="monitor.pid"

# Store start time
START_TIME=$(date +%s)

# Trap graceful shutdown (SIGTERM, SIGINT)
trap 'echo "💥 Monitor received termination signal. Running cleanup."; node dist/cleanup.js; exit' TERM INT
trap 'echo "🧹 Monitor exiting normally. Running cleanup."; node dist/cleanup.js' EXIT

# Create PID file
echo $$ > "$PID_FILE"

# Start logging
echo "Starting memory monitor at $(date)" > "$LOG_FILE"
echo "Elapsed_Time | PID | Name | Heap_Used_MB | Heap_Capacity_MB | RSS_MB" >> "$LOG_FILE"

# Main loop
while true; do
  CURRENT_TIME=$(date +%s)
  ELAPSED_TIME=$((CURRENT_TIME - START_TIME))
  TIMESTAMP=$(printf "%02d:%02d:%02d" $((ELAPSED_TIME/3600)) $((ELAPSED_TIME%3600/60)) $((ELAPSED_TIME%60)))
  jps_output=$(jps)

  while IFS= read -r line; do
    PID=$(echo "$line" | awk '{print $1}')
    NAME=$(echo "$line" | awk '{print $2}')

    for PATTERN in "${PATTERNS[@]}"; do
      if [[ "$NAME" == "$PATTERN" ]]; then
        GC_LINE=$(jstat -gc "$PID" 2>/dev/null | tail -n 1)
        [[ -z "$GC_LINE" ]] && continue

        EC=$(echo "$GC_LINE" | awk '{print $5}')
        EU=$(echo "$GC_LINE" | awk '{print $6}')
        OC=$(echo "$GC_LINE" | awk '{print $7}')
        OU=$(echo "$GC_LINE" | awk '{print $8}')

        HEAP_USED_MB=$(awk "BEGIN { printf \"%.1f\", ($EU + $OU) / 1024 }")
        HEAP_CAP_MB=$(awk "BEGIN { printf \"%.1f\", ($EC + $OC) / 1024 }")
        RSS_KB=$(ps -o rss= -p "$PID" 2>/dev/null | tr -d ' ')
        [[ -z "$RSS_KB" ]] && continue
        RSS_MB=$(awk "BEGIN { printf \"%.1f\", $RSS_KB / 1024 }")

        echo "$TIMESTAMP | $PID | $NAME | ${HEAP_USED_MB}MB | ${HEAP_CAP_MB}MB | ${RSS_MB}MB" >> "$LOG_FILE"
      fi
    done
  done <<< "$jps_output"

  sleep "$INTERVAL"
done
