package predictor

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/scoring"
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

func scoringFallbackClassifier(err error) (string, string) {
	state, message := scoring.ClassifyFallback(err)
	return string(state), message
}

func TestFallbackForErrorMapsSharedScoringTaxonomy(t *testing.T) {
	now := time.Unix(456, 0).UTC()
	tests := []struct {
		name           string
		err            error
		wantState      string
		wantDiagnostic string
	}{
		{
			name:           "no data",
			err:            fmt.Errorf("provider context: %w", scoring.ErrNoData),
			wantState:      "no_data",
			wantDiagnostic: "prediction data unavailable",
		},
		{
			name:           "scoring timeout",
			err:            fmt.Errorf("provider context: %w", scoring.ErrScoringTimeout),
			wantState:      "provider_error",
			wantDiagnostic: "prediction provider error",
		},
		{
			name:           "model unavailable",
			err:            fmt.Errorf("provider context: %w", scoring.ErrModelUnavailable),
			wantState:      "model_unavailable",
			wantDiagnostic: "prediction model unavailable",
		},
		{
			name:           "scoring failed",
			err:            fmt.Errorf("provider context: %w", scoring.ErrScoringFailed),
			wantState:      "provider_error",
			wantDiagnostic: "prediction provider error",
		},
		{
			name:           "unknown error",
			err:            fmt.Errorf("unexpected provider failure"),
			wantState:      "provider_error",
			wantDiagnostic: "prediction provider error",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotState, gotDiagnostic, gotModelVersion, checkpoint := FallbackForError(tt.err, 180, now, scoringFallbackClassifier)
			if gotState != tt.wantState {
				t.Fatalf("state = %q, want %q", gotState, tt.wantState)
			}
			if gotDiagnostic != tt.wantDiagnostic {
				t.Fatalf("diagnostic = %q, want %q", gotDiagnostic, tt.wantDiagnostic)
			}
			if gotModelVersion != "api-fallback" {
				t.Fatalf("modelVersion = %q, want api-fallback", gotModelVersion)
			}
			if checkpoint.ObservationWindowS != 180 {
				t.Fatalf("ObservationWindowS = %d, want 180", checkpoint.ObservationWindowS)
			}
			if checkpoint.Status != tt.wantState {
				t.Fatalf("Status = %q, want %q", checkpoint.Status, tt.wantState)
			}
			if checkpoint.ModelVersion != "" {
				t.Fatalf("checkpoint ModelVersion = %q, want empty", checkpoint.ModelVersion)
			}
			if checkpoint.Message != tt.wantDiagnostic {
				t.Fatalf("Message = %q, want %q", checkpoint.Message, tt.wantDiagnostic)
			}
			if !checkpoint.CreatedAt.Equal(now) {
				t.Fatalf("CreatedAt = %v, want %v", checkpoint.CreatedAt, now)
			}
			if checkpoint.ProviderID != "" {
				t.Fatalf("ProviderID = %q, want empty fallback provider", checkpoint.ProviderID)
			}
		})
	}
}

func TestFallbackForErrorDoesNotLeakPrivateDiagnosticToCheckpoint(t *testing.T) {
	err := fmt.Errorf("private stack: customer id 123: %w", scoring.ErrScoringFailed)
	_, diagnostic, _, checkpoint := FallbackForError(err, 60, time.Unix(789, 0).UTC(), scoringFallbackClassifier)

	if checkpoint.Message != "prediction provider error" {
		t.Fatalf("Message = %q, want prediction provider error", checkpoint.Message)
	}
	if diagnostic != checkpoint.Message {
		t.Fatalf("diagnostic = %q, want checkpoint message %q", diagnostic, checkpoint.Message)
	}
	if checkpoint.Message == err.Error() || strings.Contains(checkpoint.Message, "customer id") {
		t.Fatal("fallback checkpoint leaked provider diagnostic text")
	}
}

func TestFallbackForErrorUsesDefaultClassifierWhenNil(t *testing.T) {
	err := fmt.Errorf("provider context: %w", scoring.ErrNoData)
	state, diagnostic, _, checkpoint := FallbackForError(err, 60, time.Unix(1, 0).UTC(), nil)

	if state != "provider_error" {
		t.Fatalf("state = %q, want provider_error without injected classifier", state)
	}
	if diagnostic != "prediction provider error" {
		t.Fatalf("diagnostic = %q, want prediction provider error", diagnostic)
	}
	if checkpoint.Message != diagnostic || checkpoint.Status != state {
		t.Fatalf("checkpoint = %+v, want status/message matching default classifier", checkpoint)
	}
	if strings.Contains(checkpoint.Message, "no data") || strings.Contains(checkpoint.Message, err.Error()) {
		t.Fatal("default fallback leaked scoring-specific or private diagnostic text")
	}
}

func TestDefaultFallbackClassifierIsPublicSafe(t *testing.T) {
	state, message := DefaultFallbackClassifier(fmt.Errorf("private stack: customer id 123: %w", scoring.ErrModelUnavailable))
	if state != "provider_error" {
		t.Fatalf("state = %q, want provider_error", state)
	}
	if message != "prediction provider error" {
		t.Fatalf("message = %q, want prediction provider error", message)
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
		[]PredictionCheckpoint{{ObservationWindowS: 30, Status: "ready"}},
		[]int{60, 30, 180, 60},
	)

	if len(pending) != 1 || pending[0] != 60 {
		t.Fatalf("pending = %v, want [60]", pending)
	}
}

func TestPendingCheckpointsRetriesNonReadyStatuses(t *testing.T) {
	pending := PendingCheckpoints(
		[]Sample{{ElapsedTime: 180}},
		[]PredictionCheckpoint{
			{ObservationWindowS: 30, Status: "error"},
			{ObservationWindowS: 60, Status: "skipped"},
			{ObservationWindowS: 180, Status: "ready"},
		},
		[]int{30, 60, 180},
	)

	if len(pending) != 2 || pending[0] != 30 || pending[1] != 60 {
		t.Fatalf("pending = %v, want [30 60]", pending)
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
