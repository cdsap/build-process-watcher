// Package predictionqueue schedules post-ingest prediction work off the /ingest
// request path. TabFM/TimesFM must never run inside Ingest: Cloud Run buffers
// responses until the handler returns, so sync evaluation stalls the monitor.
package predictionqueue

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"regexp"
	"strings"
	"unicode"
)

// Job is the payload delivered to POST /internal/prediction-jobs.
type Job struct {
	RunID string `json:"run_id"`
}

// Scheduler enqueues prediction evaluation for a run. Implementations must return
// quickly; failures are logged by callers and must not fail ingest.
type Scheduler interface {
	Schedule(ctx context.Context, runID string, maxElapsedS int) error
}

// Noop never schedules work (tests / misconfigured deploys).
type Noop struct{}

// Schedule implements Scheduler.
func (Noop) Schedule(context.Context, string, int) error { return nil }

// Func adapts a function to Scheduler.
type Func func(ctx context.Context, runID string, maxElapsedS int) error

// Schedule implements Scheduler.
func (f Func) Schedule(ctx context.Context, runID string, maxElapsedS int) error {
	if f == nil {
		return nil
	}
	return f(ctx, runID, maxElapsedS)
}

var taskIDSanitizer = regexp.MustCompile(`[^A-Za-z0-9_-]+`)

// TaskID builds a Cloud Tasks task id used for create-time dedupe within a
// throttle bucket. Same run + bucket → AlreadyExists → one TabFM call.
func TaskID(runID string, maxElapsedS, throttleS int) string {
	if throttleS <= 0 {
		throttleS = 20
	}
	bucket := 0
	if maxElapsedS > 0 {
		bucket = maxElapsedS / throttleS
	}
	safe := taskIDSanitizer.ReplaceAllString(runID, "-")
	safe = strings.Trim(safe, "-")
	if safe == "" {
		safe = "run"
	}
	// Cloud Tasks task ids: [A-Za-z0-9_-]{1,500}
	id := fmt.Sprintf("eval-%s-b%d", safe, bucket)
	if len(id) > 500 {
		id = id[:500]
	}
	return id
}

// ThrottleForMode mirrors prediction package cadence for dedupe buckets.
func ThrottleForMode(mode string) int {
	if mode == "predict" {
		return 20
	}
	return 30
}

// EncodeJob marshals a job body for HTTP task delivery.
func EncodeJob(runID string) ([]byte, error) {
	return json.Marshal(Job{RunID: runID})
}

// DecodeJob parses a job body.
func DecodeJob(body []byte) (Job, error) {
	var job Job
	if err := json.Unmarshal(body, &job); err != nil {
		return Job{}, err
	}
	job.RunID = strings.TrimSpace(job.RunID)
	if job.RunID == "" {
		return Job{}, fmt.Errorf("run_id required")
	}
	for _, r := range job.RunID {
		if unicode.IsControl(r) {
			return Job{}, fmt.Errorf("invalid run_id")
		}
	}
	return job, nil
}

// LogScheduleError records a non-fatal enqueue failure.
func LogScheduleError(runID string, err error) {
	if err == nil {
		return
	}
	log.Printf("prediction schedule failed for run %s (ingest still OK): %v", runID, err)
}
