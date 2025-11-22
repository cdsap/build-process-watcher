#!/bin/bash

set -euo pipefail  # safer scripting: exit on error, unset vars, pipe errors

INTERVAL="${1:-5}"
PATTERNS=("GradleDaemon" "KotlinCompileDaemon" "GradleWorkerMain")
LOG_FILE="build_process_watcher.log"
PID_FILE="monitor.pid"

# Backend configuration
BACKEND_URL="${BACKEND_URL:-https://build-process-watcher-backend-685615422311.us-central1.run.app}"
RUN_ID="${RUN_ID:-build-$(date +%s)}"
ORG_REPO="${ORG_REPO:-local/dev}"
JOB_ID="${JOB_ID:-$(date +%s)}"

# Store start time
START_TIME=$(date +%s)

# Debug log file for backend requests
BACKEND_DEBUG_LOG="backend_debug.log"

# Token storage
AUTH_TOKEN=""
TOKEN_EXPIRES_AT=""

# Check debug mode
DEBUG_MODE="${DEBUG_MODE:-false}"

# Check if remote monitoring is enabled
REMOTE_MONITORING="${REMOTE_MONITORING:-false}"

# Check if GC collection is enabled
COLLECT_GC="${COLLECT_GC:-false}"

# Log current working directory (debug only)
if [ "$DEBUG_MODE" = "true" ]; then
    echo "📂 Current working directory: $(pwd)" >&2
    echo "🔧 Remote monitoring: $REMOTE_MONITORING" >&2
    echo "🗑️  GC collection: $COLLECT_GC" >&2
fi

# Initialize log file with header
if [ "$COLLECT_GC" = "true" ]; then
    echo "Elapsed_Time | PID | Name | Heap_Used_MB | Heap_Capacity_MB | RSS_MB | GC_Time_S" > "$LOG_FILE"
else
    echo "Elapsed_Time | PID | Name | Heap_Used_MB | Heap_Capacity_MB | RSS_MB" > "$LOG_FILE"
fi
if [ "$DEBUG_MODE" = "true" ]; then
    echo "✅ Log file created: $LOG_FILE" >&2
    echo "📁 Full log file path: $(pwd)/$LOG_FILE" >&2
fi

# Initialize backend debug log
echo "=== Backend Debug Log for Run ID: $RUN_ID ===" > "$BACKEND_DEBUG_LOG"
echo "Backend URL: $BACKEND_URL" >> "$BACKEND_DEBUG_LOG"
echo "Start Time: $(date)" >> "$BACKEND_DEBUG_LOG"
echo "" >> "$BACKEND_DEBUG_LOG"
if [ "$DEBUG_MODE" = "true" ]; then
    echo "✅ Backend debug log created: $BACKEND_DEBUG_LOG" >&2
    echo "📁 Full backend debug log path: $(pwd)/$BACKEND_DEBUG_LOG" >&2
fi

# Function to get or refresh authentication token
get_auth_token() {
    if [ "$DEBUG_MODE" = "true" ]; then
        echo "🔐 [$(date '+%H:%M:%S')] Requesting authentication token for run: $RUN_ID" >&2
    fi
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Requesting auth token for run_id: $RUN_ID" >> "$BACKEND_DEBUG_LOG"
    
    local auth_response
    local http_code
    
    # Request token from /auth/run/{run_id} endpoint
    auth_response=$(curl -s -w "\nHTTP_CODE:%{http_code}" -X POST "$BACKEND_URL/auth/run/$RUN_ID" \
        -H "Content-Type: application/json" 2>&1)
    
    http_code=$(echo "$auth_response" | grep -o "HTTP_CODE:[0-9]*" | cut -d: -f2)
    local response_body=$(echo "$auth_response" | sed 's/HTTP_CODE:[0-9]*$//')
    
    if [ "$http_code" = "200" ]; then
        # Extract token and expires_at from response using jq if available, otherwise use grep/sed
        if command -v jq &> /dev/null; then
            AUTH_TOKEN=$(echo "$response_body" | jq -r '.token')
            TOKEN_EXPIRES_AT=$(echo "$response_body" | jq -r '.expires_at')
        else
            # Fallback parsing without jq
            AUTH_TOKEN=$(echo "$response_body" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
            TOKEN_EXPIRES_AT=$(echo "$response_body" | grep -o '"expires_at":"[^"]*"' | cut -d'"' -f4)
        fi
        
        if [ "$DEBUG_MODE" = "true" ]; then
            echo "✅ [$(date '+%H:%M:%S')] Authentication token obtained successfully" >&2
            echo "   Token expires at: $TOKEN_EXPIRES_AT" >&2
        fi
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✅ Token obtained successfully, expires at: $TOKEN_EXPIRES_AT" >> "$BACKEND_DEBUG_LOG"
        echo "" >> "$BACKEND_DEBUG_LOG"
        return 0
    else
        echo "❌ [$(date '+%H:%M:%S')] Failed to obtain authentication token (HTTP $http_code)" >&2
        echo "   Response: $response_body" >&2
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] ❌ Failed to obtain token (HTTP $http_code)" >> "$BACKEND_DEBUG_LOG"
        echo "Response: $response_body" >> "$BACKEND_DEBUG_LOG"
        echo "" >> "$BACKEND_DEBUG_LOG"
        return 1
    fi
}

# Function to send data to backend
send_to_backend() {
    local timestamp="$1"
    local pid="$2"
    local name="$3"
    local heap_used="$4"
    local heap_cap="$5"
    local rss="$6"
    local gc_time="${7:-}"
    
    # Prepare data in the format expected by our backend
    if [ -n "$gc_time" ]; then
        local data_line="$timestamp | $pid | $name | $heap_used | $heap_cap | $rss | $gc_time"
    else
        local data_line="$timestamp | $pid | $name | $heap_used | $heap_cap | $rss"
    fi
    
    # Prepare JSON payload in the format our backend expects
    local json_payload=$(cat <<EOF
{
    "run_id": "$RUN_ID",
    "data": "$data_line"
}
EOF
)
    
    # Log the request attempt (both to file and console)
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Attempting to send data for $pid ($name) at $timestamp" >> "$BACKEND_DEBUG_LOG"
    echo "Request URL: $BACKEND_URL/ingest" >> "$BACKEND_DEBUG_LOG"
    echo "Payload: $json_payload" >> "$BACKEND_DEBUG_LOG"
    
    # Also print to console for real-time visibility (debug mode only)
    if [ "$DEBUG_MODE" = "true" ]; then
        echo "📤 [$(date '+%H:%M:%S')] Sending data for $pid ($name) at $timestamp" >&2
        echo "   URL: $BACKEND_URL/ingest" >&2
        echo "   Payload: $json_payload" >&2
    fi
    
    # Ensure we have a valid auth token
    if [ -z "$AUTH_TOKEN" ]; then
        echo "   ⚠️  No auth token available, requesting one..." >&2
        if ! get_auth_token; then
            echo "   ❌ Failed to get auth token, skipping this send" >&2
            echo "[$(date '+%Y-%m-%d %H:%M:%S')] ❌ Failed to send: No auth token available" >> "$BACKEND_DEBUG_LOG"
            return 1
        fi
    fi
    
    # Send to backend (with error handling)
    local curl_output
    local curl_exit_code
    
    if [ "$DEBUG_MODE" = "true" ]; then
        echo "   Using auth token for authentication" >&2
    fi
    curl_output=$(curl -s -w "HTTP_CODE:%{http_code}" -X POST "$BACKEND_URL/ingest" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $AUTH_TOKEN" \
        -d "$json_payload" 2>&1)
    curl_exit_code=$?
    
    # Extract HTTP code and response
    local http_code=$(echo "$curl_output" | grep -o "HTTP_CODE:[0-9]*" | cut -d: -f2)
    local response_body=$(echo "$curl_output" | sed 's/HTTP_CODE:[0-9]*$//')
    
    if [ $curl_exit_code -eq 0 ] && [ "$http_code" = "200" ]; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✅ SUCCESS: Sent data for $pid ($name) at $timestamp (HTTP $http_code)" >> "$BACKEND_DEBUG_LOG"
        if [ "$DEBUG_MODE" = "true" ]; then
            echo "✅ [$(date '+%H:%M:%S')] SUCCESS: Sent data for $pid ($name) (HTTP $http_code)" >&2
            echo "[backend] Sent data for $pid ($name) at $timestamp" >&2
        fi
    elif [ "$http_code" = "401" ]; then
        # Token expired or invalid, try to get a new one
        echo "   🔄 Token expired (HTTP 401), requesting new token..." >&2
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] 🔄 Token expired, requesting new token" >> "$BACKEND_DEBUG_LOG"
        
        if get_auth_token; then
            # Retry the request with the new token
            if [ "$DEBUG_MODE" = "true" ]; then
                echo "   🔄 Retrying with new token..." >&2
            fi
            curl_output=$(curl -s -w "HTTP_CODE:%{http_code}" -X POST "$BACKEND_URL/ingest" \
                -H "Content-Type: application/json" \
                -H "Authorization: Bearer $AUTH_TOKEN" \
                -d "$json_payload" 2>&1)
            curl_exit_code=$?
            http_code=$(echo "$curl_output" | grep -o "HTTP_CODE:[0-9]*" | cut -d: -f2)
            response_body=$(echo "$curl_output" | sed 's/HTTP_CODE:[0-9]*$//')
            
            if [ $curl_exit_code -eq 0 ] && [ "$http_code" = "200" ]; then
                echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✅ SUCCESS (retry): Sent data for $pid ($name) at $timestamp (HTTP $http_code)" >> "$BACKEND_DEBUG_LOG"
                if [ "$DEBUG_MODE" = "true" ]; then
                    echo "✅ [$(date '+%H:%M:%S')] SUCCESS (retry): Sent data for $pid ($name) (HTTP $http_code)" >&2
                fi
            else
                echo "[$(date '+%Y-%m-%d %H:%M:%S')] ❌ FAILED (retry): Failed to send data for $pid ($name) at $timestamp" >> "$BACKEND_DEBUG_LOG"
                echo "HTTP code: $http_code" >> "$BACKEND_DEBUG_LOG"
                echo "Response: $response_body" >> "$BACKEND_DEBUG_LOG"
                echo "❌ [$(date '+%H:%M:%S')] FAILED (retry): Send data for $pid ($name) failed (HTTP $http_code)" >&2
            fi
        fi
    else
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] ❌ FAILED: Failed to send data for $pid ($name) at $timestamp" >> "$BACKEND_DEBUG_LOG"
        echo "Curl exit code: $curl_exit_code" >> "$BACKEND_DEBUG_LOG"
        echo "HTTP code: $http_code" >> "$BACKEND_DEBUG_LOG"
        echo "Response: $response_body" >> "$BACKEND_DEBUG_LOG"
        echo "❌ [$(date '+%H:%M:%S')] FAILED: Send data for $pid ($name) failed" >&2
        echo "   HTTP Code: $http_code" >&2
        echo "   Response: $response_body" >&2
        echo "[backend] Failed to send data for $pid ($name) at $timestamp" >&2
    fi
    echo "" >> "$BACKEND_DEBUG_LOG"
}

# Request initial authentication token
if [ "$DEBUG_MODE" = "true" ]; then
    echo "🔐 Requesting initial authentication token..." >&2
fi
if ! get_auth_token; then
    echo "⚠️  Failed to get initial authentication token - will retry on first send" >&2
fi

# Trap graceful shutdown (SIGTERM, SIGINT)
trap 'echo "💥 Monitor received termination signal. Running cleanup."; node dist/cleanup.js; exit' TERM INT
trap 'echo "🧹 Monitor exiting normally. Running cleanup."; node dist/cleanup.js' EXIT

# Create PID file
echo $$ > "$PID_FILE"

# Start logging
echo "Starting memory monitor with backend integration at $(date)" > "$LOG_FILE"
echo "Elapsed_Time | PID | Name | Heap_Used_MB | Heap_Capacity_MB | RSS_MB" >> "$LOG_FILE"

# Test backend connectivity and fallback to local mode if needed
# Skip backend entirely if remote monitoring is disabled
BACKEND_AVAILABLE=false

if [ "$REMOTE_MONITORING" = "true" ]; then
    if [ "$DEBUG_MODE" = "true" ]; then
        echo "Testing backend connectivity to $BACKEND_URL..."
    fi
    
    if curl -s "$BACKEND_URL/healthz" > /dev/null 2>&1; then
        if [ "$DEBUG_MODE" = "true" ]; then
            echo "✅ Backend is reachable at $BACKEND_URL"
        fi
        BACKEND_AVAILABLE=true
    else
        echo "⚠️  Backend not reachable at $BACKEND_URL"
        echo "🔄 Falling back to local monitoring mode..." >&2
        BACKEND_AVAILABLE=false
    fi
else
    if [ "$DEBUG_MODE" = "true" ]; then
        echo "📝 Remote monitoring disabled, using local mode"
    fi
fi

# If backend is not available, switch to local monitoring
if [ "$BACKEND_AVAILABLE" = "false" ]; then
    echo "📝 Switching to local monitoring mode - data will be logged to: $LOG_FILE" >&2
    if [ "$DEBUG_MODE" = "true" ]; then
        echo "🔄 Starting local monitoring loop..." >&2
        echo "🔍 Looking for Java processes matching patterns: ${PATTERNS[*]}" >&2
    fi
    
    while true; do
        CURRENT_TIME=$(date +%s)
        ELAPSED_TIME=$((CURRENT_TIME - START_TIME))
        TIMESTAMP=$(printf "%02d:%02d:%02d" $((ELAPSED_TIME/3600)) $((ELAPSED_TIME%3600/60)) $((ELAPSED_TIME%60)))
        jps_output=$(jps)
        
        if [ "$DEBUG_MODE" = "true" ]; then
            echo "🔍 [${TIMESTAMP}] Checking for Java processes..." >&2
            echo "📋 jps output: $jps_output" >&2
        fi

        # Array to collect all process data for this timestamp
        declare -a process_data=()

        while IFS= read -r line; do
            PID=$(echo "$line" | awk '{print $1}')
            NAME=$(echo "$line" | awk '{print $2}')
            
            # Check if this process matches any of our patterns
            for pattern in "${PATTERNS[@]}"; do
                if [[ "$NAME" == *"$pattern"* ]]; then
                    # Get memory info for this process
                    if [ -f "/proc/$PID/status" ]; then
                        HEAP_USED=$(ps -p "$PID" -o rss= 2>/dev/null | awk '{print int($1/1024)}' || echo "0")
                        HEAP_CAP=$(ps -p "$PID" -o vsz= 2>/dev/null | awk '{print int($1/1024)}' || echo "0")
                        RSS=$(ps -p "$PID" -o rss= 2>/dev/null | awk '{print int($1/1024)}' || echo "0")
                        
                        # Store data for this timestamp
                        if [ "$COLLECT_GC" = "true" ]; then
                          process_data+=("$ELAPSED_TIME | $PID | $NAME | $HEAP_USED | $HEAP_CAP | $RSS | N/A")
                        else
                          process_data+=("$ELAPSED_TIME | $PID | $NAME | $HEAP_USED | $HEAP_CAP | $RSS")
                        fi
                    fi
                    break
                fi
            done
        done <<< "$jps_output"

        # Log all processes found at this timestamp
        for data in "${process_data[@]}"; do
            echo "$data" >> "$LOG_FILE"
            if [ "$DEBUG_MODE" = "true" ]; then
                echo "📊 [${TIMESTAMP}] $data" >&2
            fi
        done

        if [ "$DEBUG_MODE" = "true" ]; then
            echo "📊 [${TIMESTAMP}] Monitoring cycle complete. Sleeping for ${INTERVAL}s..." >&2
        fi
        sleep "$INTERVAL"
    done
fi

# Main loop
if [ "$DEBUG_MODE" = "true" ]; then
    echo "🔄 Starting monitoring loop..." >&2
    echo "🔍 Looking for Java processes matching patterns: ${PATTERNS[*]}" >&2
fi

while true; do
  CURRENT_TIME=$(date +%s)
  ELAPSED_TIME=$((CURRENT_TIME - START_TIME))
  TIMESTAMP=$(printf "%02d:%02d:%02d" $((ELAPSED_TIME/3600)) $((ELAPSED_TIME%3600/60)) $((ELAPSED_TIME%60)))
  jps_output=$(jps)
  
  if [ "$DEBUG_MODE" = "true" ]; then
      echo "🔍 [${TIMESTAMP}] Checking for Java processes..." >&2
      echo "📋 jps output: $jps_output" >&2
  fi

  # Array to collect all process data for this timestamp
  declare -a process_data=()

  while IFS= read -r line; do
    PID=$(echo "$line" | awk '{print $1}')
    NAME=$(echo "$line" | awk '{print $2}')

    for PATTERN in "${PATTERNS[@]}"; do
      if [[ "$NAME" == "$PATTERN" ]]; then
        if [ "$DEBUG_MODE" = "true" ]; then
            echo "✅ Found matching process: $PID ($NAME)" >&2
        fi
        {
          GC_LINE=$(jstat -gc "$PID" 2>/dev/null | tail -n 1)
          RSS_KB=$(ps -o rss= -p "$PID" 2>/dev/null | tr -d ' ')
          [[ -z "$RSS_KB" ]] && continue
          RSS_MB=$(awk "BEGIN { printf \"%.1f\", $RSS_KB / 1024 }")

          if [[ -z "$GC_LINE" ]]; then
            if [ "$COLLECT_GC" = "true" ]; then
              echo "$TIMESTAMP | $PID | $NAME | N/A | N/A | ${RSS_MB}MB | N/A" >> "$LOG_FILE"
              # Store process data for batch sending
              process_data+=("$TIMESTAMP|$PID|$NAME|0|0|${RSS_MB}MB|N/A")
            else
              echo "$TIMESTAMP | $PID | $NAME | N/A | N/A | ${RSS_MB}MB" >> "$LOG_FILE"
              # Store process data for batch sending
              process_data+=("$TIMESTAMP|$PID|$NAME|0|0|${RSS_MB}MB")
            fi
          else
            EC=$(echo "$GC_LINE" | awk '{print $5}')
            EU=$(echo "$GC_LINE" | awk '{print $6}')
            OC=$(echo "$GC_LINE" | awk '{print $7}')
            OU=$(echo "$GC_LINE" | awk '{print $8}')

            HEAP_USED_MB=$(awk "BEGIN { printf \"%.1f\", ($EU + $OU) / 1024 }")
            HEAP_CAP_MB=$(awk "BEGIN { printf \"%.1f\", ($EC + $OC) / 1024 }")

            if [ "$COLLECT_GC" = "true" ]; then
              # Extract GC time from jstat output
              # YGCT (column 14) = Young generation GC time in seconds
              # FGCT (column 16) = Full GC time in seconds
              # Total GC time = YGCT + FGCT (keep in seconds)
              # This works consistently across all GC collectors (Parallel, G1, Serial, CMS, etc.)
              YGCT=$(echo "$GC_LINE" | awk '{print $14}' 2>/dev/null || echo "0")
              FGCT=$(echo "$GC_LINE" | awk '{print $16}' 2>/dev/null || echo "0")
              # Calculate total GC time (keep in seconds, as reported by jstat)
              if [ "$YGCT" != "N/A" ] && [ "$FGCT" != "N/A" ] && [ -n "$YGCT" ] && [ -n "$FGCT" ]; then
                GC_TIME_S=$(awk "BEGIN { printf \"%.3f\", $YGCT + $FGCT }" 2>/dev/null || echo "N/A")
              else
                GC_TIME_S="N/A"
              fi
              echo "$TIMESTAMP | $PID | $NAME | ${HEAP_USED_MB}MB | ${HEAP_CAP_MB}MB | ${RSS_MB}MB | ${GC_TIME_S}s" >> "$LOG_FILE"
              # Store process data for batch sending
              process_data+=("$TIMESTAMP|$PID|$NAME|${HEAP_USED_MB}MB|${HEAP_CAP_MB}MB|${RSS_MB}MB|${GC_TIME_S}s")
            else
              echo "$TIMESTAMP | $PID | $NAME | ${HEAP_USED_MB}MB | ${HEAP_CAP_MB}MB | ${RSS_MB}MB" >> "$LOG_FILE"
              # Store process data for batch sending
              process_data+=("$TIMESTAMP|$PID|$NAME|${HEAP_USED_MB}MB|${HEAP_CAP_MB}MB|${RSS_MB}MB")
            fi
          fi
        } || { echo "[monitor.sh] Skipped process $PID ($NAME) at $TIMESTAMP due to error" >&2; continue; }
      fi
    done
  done <<< "$jps_output"

  # Send all collected process data with the same timestamp
  if [ ${#process_data[@]} -gt 0 ]; then
    if [ "$DEBUG_MODE" = "true" ]; then
        echo "📤 [${TIMESTAMP}] Sending ${#process_data[@]} processes to backend..." >&2
    fi
    for data_line in "${process_data[@]}"; do
      if [ "$COLLECT_GC" = "true" ]; then
        IFS='|' read -r ts pid name heap_used heap_cap rss gc_time <<< "$data_line"
        send_to_backend "$ts" "$pid" "$name" "${heap_used}MB" "${heap_cap}MB" "${rss}MB" "$gc_time"
      else
        IFS='|' read -r ts pid name heap_used heap_cap rss <<< "$data_line"
        send_to_backend "$ts" "$pid" "$name" "${heap_used}MB" "${heap_cap}MB" "${rss}MB"
      fi
    done
  fi

  sleep "$INTERVAL"
done
