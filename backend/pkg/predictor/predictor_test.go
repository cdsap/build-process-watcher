package predictor

import (
	"context"
	"testing"
	"time"
)

type fakeProvider struct{}

func (fakeProvider) Predict(context.Context, RunSnapshot, int) (PredictionCheckpoint, error) {
	return PredictionCheckpoint{}, nil
}

func TestNoopProviderReturnsSkippedCheckpoint(t *testing.T) {
	now := time.Unix(123, 0)
	checkpoint, err := NoopProvider{}.Predict(context.Background(), RunSnapshot{
		RunID: "run-1",
		Now:   now,
	}, 60)
	if err != nil {
		t.Fatal(err)
	}

	if checkpoint.ObservationWindowS != 60 {
		t.Fatalf("ObservationWindowS = %d, want 60", checkpoint.ObservationWindowS)
	}
	if checkpoint.Status != "skipped" {
		t.Fatalf("Status = %q, want skipped", checkpoint.Status)
	}
	if checkpoint.ProviderID != "noop" {
		t.Fatalf("ProviderID = %q, want noop", checkpoint.ProviderID)
	}
	if !checkpoint.CreatedAt.Equal(now) {
		t.Fatalf("CreatedAt = %v, want %v", checkpoint.CreatedAt, now)
	}
}

func TestEnabled(t *testing.T) {
	if Enabled(nil) {
		t.Fatal("nil provider should not be enabled")
	}
	if Enabled(NoopProvider{}) {
		t.Fatal("noop provider should not be enabled")
	}
	if Enabled(&NoopProvider{}) {
		t.Fatal("noop provider pointer should not be enabled")
	}
	if !Enabled(fakeProvider{}) {
		t.Fatal("fake provider should be enabled")
	}
}

func TestDefaultCheckpoints(t *testing.T) {
	checkpoints := DefaultCheckpoints()
	expected := []int{60, 300, 600, 1200}
	if len(checkpoints) != len(expected) {
		t.Fatalf("checkpoints = %v, want %v", checkpoints, expected)
	}
	for i := range expected {
		if checkpoints[i] != expected[i] {
			t.Fatalf("checkpoints = %v, want %v", checkpoints, expected)
		}
	}

	checkpoints[0] = 1
	if got := DefaultCheckpoints()[0]; got != 60 {
		t.Fatalf("DefaultCheckpoints returned shared storage; first = %d, want 60", got)
	}
}

func TestPendingCheckpointsReturnsReachedMissingWindows(t *testing.T) {
	pending := PendingCheckpoints(
		[]Sample{{ElapsedTime: 10}, {ElapsedTime: 75}},
		[]PredictionCheckpoint{{ObservationWindowS: 30}},
		[]int{60, 30, 180, 60},
	)

	if len(pending) != 1 || pending[0] != 60 {
		t.Fatalf("pending = %v, want [60]", pending)
	}
}

func TestPendingCheckpointsTreatsAnyStoredStatusAsComplete(t *testing.T) {
	pending := PendingCheckpoints(
		[]Sample{{ElapsedTime: 180}},
		[]PredictionCheckpoint{
			{ObservationWindowS: 30, Status: "error"},
			{ObservationWindowS: 60, Status: "skipped"},
		},
		[]int{30, 60, 180},
	)

	if len(pending) != 1 || pending[0] != 180 {
		t.Fatalf("pending = %v, want [180]", pending)
	}
}

func TestPendingCheckpointsSkipsWhenNoSamples(t *testing.T) {
	if pending := PendingCheckpoints(nil, nil, []int{30}); len(pending) != 0 {
		t.Fatalf("pending = %v, want empty", pending)
	}
}

func TestParseCheckpoints(t *testing.T) {
	checkpoints := ParseCheckpoints("30, 60, bad, 0, 180, 60")
	expected := []int{30, 60, 180}
	if len(checkpoints) != len(expected) {
		t.Fatalf("checkpoints = %v, want %v", checkpoints, expected)
	}
	for i := range expected {
		if checkpoints[i] != expected[i] {
			t.Fatalf("checkpoints = %v, want %v", checkpoints, expected)
		}
	}
}
