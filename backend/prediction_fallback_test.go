package main

import (
	"fmt"
	"strings"
	"testing"

	"github.com/cdsap/build-process-watcher/backend/internal/scoring"
)

func TestPredictionFallbackClassifierMapsScoringTaxonomyWithoutLeaking(t *testing.T) {
	tests := []struct {
		name        string
		err         error
		wantState   string
		wantMessage string
	}{
		{
			name:        "no data",
			err:         fmt.Errorf("provider context: %w", scoring.ErrNoData),
			wantState:   "no_data",
			wantMessage: "prediction data unavailable",
		},
		{
			name:        "model unavailable",
			err:         fmt.Errorf("provider context: %w", scoring.ErrModelUnavailable),
			wantState:   "model_unavailable",
			wantMessage: "prediction model unavailable",
		},
		{
			name:        "scoring failed",
			err:         fmt.Errorf("private stack: customer id 123: %w", scoring.ErrScoringFailed),
			wantState:   "provider_error",
			wantMessage: "prediction provider error",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			state, message := predictionFallbackClassifier(tt.err)
			if state != tt.wantState {
				t.Fatalf("state = %q, want %q", state, tt.wantState)
			}
			if message != tt.wantMessage {
				t.Fatalf("message = %q, want %q", message, tt.wantMessage)
			}
			if message == tt.err.Error() || strings.Contains(message, "customer id") {
				t.Fatal("startup classifier leaked private diagnostic text")
			}
		})
	}
}
