package handlers

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/models"
	"github.com/cdsap/build-process-watcher/backend/internal/scoring"
)

func TestIngestHandler_RequestWithProcessInfo(t *testing.T) {
	// Test that IngestRequest with ProcessInfo can be properly parsed
	request := models.IngestRequest{
		RunID: "test-run-123",
		Data:  "00:00:01 | 12345 | GradleDaemon | 100MB | 200MB | 300MB",
		ProcessInfo: &models.ProcessInfo{
			PID:     "12345",
			Name:    "GradleDaemon",
			VMFlags: []string{"-XX:+UseG1GC", "-XX:MaxHeapSize=2g"},
		},
	}

	jsonData, err := json.Marshal(request)
	if err != nil {
		t.Fatalf("Failed to marshal request: %v", err)
	}

	// Verify it can be unmarshaled correctly
	var unmarshaled models.IngestRequest
	if err := json.Unmarshal(jsonData, &unmarshaled); err != nil {
		t.Fatalf("Failed to unmarshal request: %v", err)
	}

	if unmarshaled.ProcessInfo == nil {
		t.Fatal("ProcessInfo should not be nil")
	}

	if unmarshaled.ProcessInfo.PID != "12345" {
		t.Errorf("PID mismatch: expected 12345, got %s", unmarshaled.ProcessInfo.PID)
	}

	if len(unmarshaled.ProcessInfo.VMFlags) != 2 {
		t.Errorf("Expected 2 VM flags, got %d", len(unmarshaled.ProcessInfo.VMFlags))
	}
}

func TestBoolQueryAcceptsExplicitTrueOnly(t *testing.T) {
	request := httptest.NewRequest("POST", "/auth/run/run-1?predictive_reliability=true", nil)
	if !boolQuery(request, "predictive_reliability") {
		t.Fatal("expected predictive_reliability=true to be accepted")
	}

	request = httptest.NewRequest("POST", "/auth/run/run-1?predictive_reliability=false", nil)
	if boolQuery(request, "predictive_reliability") {
		t.Fatal("expected predictive_reliability=false to be rejected")
	}

	request = httptest.NewRequest("POST", "/auth/run/run-1?predictive_reliability=maybe", nil)
	if boolQuery(request, "predictive_reliability") {
		t.Fatal("expected invalid predictive_reliability value to be rejected")
	}
}

func TestClassifyPredictionFallbackUsesSharedScoringTaxonomy(t *testing.T) {
	tests := []struct {
		name        string
		err         error
		wantStatus  string
		wantMessage string
	}{
		{
			name:        "no data",
			err:         fmt.Errorf("provider context: %w", scoring.ErrNoData),
			wantStatus:  "no_data",
			wantMessage: "prediction data unavailable",
		},
		{
			name:        "model unavailable",
			err:         fmt.Errorf("provider context: %w", scoring.ErrModelUnavailable),
			wantStatus:  "model_unavailable",
			wantMessage: "prediction model unavailable",
		},
		{
			name:        "scoring failed",
			err:         fmt.Errorf("provider context: %w", scoring.ErrScoringFailed),
			wantStatus:  "provider_error",
			wantMessage: "prediction provider error",
		},
		{
			name:        "scoring timeout",
			err:         fmt.Errorf("provider context: %w", scoring.ErrScoringTimeout),
			wantStatus:  "provider_error",
			wantMessage: "prediction provider error",
		},
		{
			name:        "unknown error",
			err:         fmt.Errorf("unexpected provider failure"),
			wantStatus:  "provider_error",
			wantMessage: "prediction provider error",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotStatus, gotMessage := classifyPredictionFallback(tt.err)
			if gotStatus != tt.wantStatus {
				t.Fatalf("status = %q, want %q", gotStatus, tt.wantStatus)
			}
			if gotMessage != tt.wantMessage {
				t.Fatalf("message = %q, want %q", gotMessage, tt.wantMessage)
			}
		})
	}
}

func TestRunResponse_WithProcessInfo(t *testing.T) {
	// Test that RunResponse correctly includes ProcessInfo
	processInfo := make(map[string]models.ProcessInfo)
	processInfo["12345"] = models.ProcessInfo{
		PID:     "12345",
		Name:    "GradleDaemon",
		VMFlags: []string{"-XX:+UseG1GC", "-XX:MaxHeapSize=2g"},
	}

	response := models.RunResponse{
		Samples:     []models.Sample{},
		ProcessInfo: processInfo,
		Finished:    false,
	}

	jsonData, err := json.Marshal(response)
	if err != nil {
		t.Fatalf("Failed to marshal RunResponse: %v", err)
	}

	var unmarshaled models.RunResponse
	if err := json.Unmarshal(jsonData, &unmarshaled); err != nil {
		t.Fatalf("Failed to unmarshal RunResponse: %v", err)
	}

	if unmarshaled.ProcessInfo == nil {
		t.Fatal("ProcessInfo should not be nil in response")
	}

	if len(unmarshaled.ProcessInfo) != 1 {
		t.Errorf("Expected 1 process info entry, got %d", len(unmarshaled.ProcessInfo))
	}

	stored, ok := unmarshaled.ProcessInfo["12345"]
	if !ok {
		t.Fatal("Process info for PID 12345 not found in response")
	}

	if stored.PID != "12345" {
		t.Errorf("PID mismatch: expected 12345, got %s", stored.PID)
	}

	if len(stored.VMFlags) != 2 {
		t.Errorf("Expected 2 VM flags, got %d", len(stored.VMFlags))
	}
}

func TestRunResponse_WithoutProcessInfo(t *testing.T) {
	// Test that RunResponse works when ProcessInfo is nil
	response := models.RunResponse{
		Samples:     []models.Sample{},
		ProcessInfo: nil,
		Finished:    false,
	}

	jsonData, err := json.Marshal(response)
	if err != nil {
		t.Fatalf("Failed to marshal RunResponse: %v", err)
	}

	var unmarshaled models.RunResponse
	if err := json.Unmarshal(jsonData, &unmarshaled); err != nil {
		t.Fatalf("Failed to unmarshal RunResponse: %v", err)
	}

	// ProcessInfo can be nil when not present
	if unmarshaled.ProcessInfo != nil && len(unmarshaled.ProcessInfo) > 0 {
		t.Error("ProcessInfo should be nil or empty when not present")
	}
}

func TestRunResponse_WithPredictionCheckpoints(t *testing.T) {
	createdAt := time.Unix(123, 0).UTC()
	response := models.RunResponse{
		Samples: []models.Sample{},
		PredictionCheckpoints: []models.PredictionCheckpoint{
			{
				ObservationWindowS: 180,
				Status:             "ready",
				RiskLevel:          "low",
				Confidence:         "medium",
				Signals:            []string{"stable memory"},
				ProviderID:         "private",
				ModelVersion:       "opaque-v1",
				CreatedAt:          createdAt,
			},
		},
		Finished: false,
	}

	jsonData, err := json.Marshal(response)
	if err != nil {
		t.Fatalf("Failed to marshal RunResponse: %v", err)
	}

	var unmarshaled models.RunResponse
	if err := json.Unmarshal(jsonData, &unmarshaled); err != nil {
		t.Fatalf("Failed to unmarshal RunResponse: %v", err)
	}

	if len(unmarshaled.PredictionCheckpoints) != 1 {
		t.Fatalf("Expected 1 prediction checkpoint, got %d", len(unmarshaled.PredictionCheckpoints))
	}
	if unmarshaled.PredictionCheckpoints[0].ObservationWindowS != 180 {
		t.Fatalf("Prediction window = %d, want 180", unmarshaled.PredictionCheckpoints[0].ObservationWindowS)
	}
}
