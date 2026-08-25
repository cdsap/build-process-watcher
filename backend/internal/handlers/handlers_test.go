package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/models"
	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
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

func TestNewHandlersWithPredictorUsesInjectedFallbackClassifier(t *testing.T) {
	h := NewHandlersWithPredictor(nil, nil, predictor.NoopProvider{}, nil, func(error) (string, string) {
		return "no_data", "prediction data unavailable"
	})
	state, message := h.fallbackClassifier(errors.New("ignored"))
	if state != "no_data" || message != "prediction data unavailable" {
		t.Fatalf("classifier = (%q, %q), want injected mapping", state, message)
	}
}

func TestNewHandlersWithPredictorDefaultsFallbackClassifier(t *testing.T) {
	h := NewHandlersWithPredictor(nil, nil, nil, nil, nil)
	err := fmt.Errorf("private stack: customer id 9: boom")
	state, message := h.fallbackClassifier(err)
	if state != "provider_error" || message != "prediction provider error" {
		t.Fatalf("classifier = (%q, %q), want default public-safe mapping", state, message)
	}
	if strings.Contains(message, "customer id") || message == err.Error() {
		t.Fatal("default fallback classifier leaked private diagnostic text")
	}
}
