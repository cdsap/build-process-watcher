package predictionqueue

import (
	"testing"
)

func TestTaskIDStableWithinBucket(t *testing.T) {
	a := TaskID("predict-1-baseline", 21, 10)
	b := TaskID("predict-1-baseline", 29, 10)
	c := TaskID("predict-1-baseline", 30, 10)
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

func TestTaskIDUsesShared20sThrottleDefault(t *testing.T) {
	if got := ThrottleSeconds(); got != 20 {
		t.Fatalf("ThrottleSeconds = %d, want 20", got)
	}
	// 0–19 → bucket 0, 20–39 → bucket 1 when using the shared default.
	if id := TaskID("run-a", 19, ThrottleSeconds()); id != "eval-run-a-b0" {
		t.Fatalf("19s task id = %q", id)
	}
	if id := TaskID("run-a", 20, ThrottleSeconds()); id != "eval-run-a-b1" {
		t.Fatalf("20s task id = %q", id)
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
