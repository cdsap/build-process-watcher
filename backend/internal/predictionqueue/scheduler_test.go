package predictionqueue

import (
	"testing"

	"github.com/cdsap/build-process-watcher/backend/internal/models"
)

func TestTaskIDStableWithinBucket(t *testing.T) {
	a := TaskID("predict-1-baseline", 41, 0) // 0 → ThrottleElapsedSeconds
	b := TaskID("predict-1-baseline", 59, models.ThrottleElapsedSeconds)
	c := TaskID("predict-1-baseline", 60, models.ThrottleElapsedSeconds)
	if a != b {
		t.Fatalf("same bucket ids differ: %q vs %q", a, b)
	}
	if a == c {
		t.Fatalf("adjacent buckets should differ: %q", a)
	}
	if a != "eval-predict-1-baseline-b2" {
		t.Fatalf("task id = %q", a)
	}
}

func TestDecodeJobRequiresRunID(t *testing.T) {
	if _, err := DecodeJob([]byte(`{}`)); err == nil {
		t.Fatal("expected error for missing run_id")
	}
	job, err := DecodeJob([]byte(`{"run_id":"run-1"}`))
	if err != nil || job.RunID != "run-1" {
		t.Fatalf("job=%v err=%v", job, err)
	}
}
