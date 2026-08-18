package scoring

import (
	"fmt"
	"testing"
)

func TestClassifyFallbackMapsSharedScoringTaxonomy(t *testing.T) {
	tests := []struct {
		name        string
		err         error
		wantState   State
		wantMessage string
	}{
		{
			name:        "no data",
			err:         fmt.Errorf("provider context: %w", ErrNoData),
			wantState:   StateNoData,
			wantMessage: "prediction data unavailable",
		},
		{
			name:        "model unavailable",
			err:         fmt.Errorf("provider context: %w", ErrModelUnavailable),
			wantState:   StateModelUnavailable,
			wantMessage: "prediction model unavailable",
		},
		{
			name:        "scoring failed",
			err:         fmt.Errorf("provider context: %w", ErrScoringFailed),
			wantState:   StateProviderError,
			wantMessage: "prediction provider error",
		},
		{
			name:        "scoring timeout",
			err:         fmt.Errorf("provider context: %w", ErrScoringTimeout),
			wantState:   StateProviderError,
			wantMessage: "prediction provider error",
		},
		{
			name:        "unknown error",
			err:         fmt.Errorf("unexpected provider failure"),
			wantState:   StateProviderError,
			wantMessage: "prediction provider error",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotState, gotMessage := ClassifyFallback(tt.err)
			if gotState != tt.wantState {
				t.Fatalf("state = %q, want %q", gotState, tt.wantState)
			}
			if gotMessage != tt.wantMessage {
				t.Fatalf("message = %q, want %q", gotMessage, tt.wantMessage)
			}
		})
	}
}
