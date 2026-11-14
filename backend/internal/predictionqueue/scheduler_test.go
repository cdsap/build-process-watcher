package predictionqueue

import (
	"testing"
)

func TestTaskIDStableWithinBucket(t *testing.T) {
	a := TaskID("predict-1-baseline", 41, 20)
	b := TaskID("predict-1-baseline", 59, 20)
	c := TaskID("predict-1-baseline", 60, 20)
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
