#!/bin/bash
set -euo pipefail

PID="${1:-}"
ITERATIONS="${ITERATIONS:-20}"

if [ -z "$PID" ]; then
  echo "Usage: $0 <java-pid>" >&2
  exit 1
fi

measure() {
  local label="$1"
  shift
  local start end
  start=$(date +%s%N)
  for ((i = 0; i < ITERATIONS; i++)); do
    "$@" >/dev/null 2>&1 || true
  done
  end=$(date +%s%N)
  awk -v label="$label" -v elapsed="$((end - start))" -v count="$ITERATIONS" 'BEGIN { printf "%s: %.2f ms/sample over %d iterations\n", label, elapsed / count / 1000000, count }'
}

measure "memory+gc" jstat -gc "$PID"
measure "jit" jstat -compiler "$PID"
measure "class-loading" jstat -class "$PID"
