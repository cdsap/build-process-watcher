package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/auth"
	"github.com/cdsap/build-process-watcher/backend/internal/models"
	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
)

type fakeStorage struct {
	runs                  map[string]*models.RunDoc
	processes             map[string]*models.ProcessDoc
	exportToBigQuery      map[string]bool
	predictiveReliability map[string]bool
	storedSamples         []models.Sample
	storedProcessInfo     []models.ProcessInfo
	finishedRuns          []string
}

func newFakeStorage() *fakeStorage {
	return &fakeStorage{
		runs:                  make(map[string]*models.RunDoc),
		processes:             make(map[string]*models.ProcessDoc),
		exportToBigQuery:      make(map[string]bool),
		predictiveReliability: make(map[string]bool),
	}
}

func (f *fakeStorage) GetRun(runID string) (*models.RunDoc, error) {
	run, ok := f.runs[runID]
	if !ok {
		return nil, fmt.Errorf("run %s not found", runID)
	}
	return run, nil
}

func (f *fakeStorage) GetProcesses(runID string) (*models.ProcessDoc, error) {
	processes, ok := f.processes[runID]
	if !ok {
		return nil, fmt.Errorf("processes for run %s not found", runID)
	}
	return processes, nil
}

func (f *fakeStorage) StoreSamples(runID string, samples []models.Sample) error {
	f.storedSamples = append(f.storedSamples, samples...)
	if _, ok := f.runs[runID]; !ok {
		f.runs[runID] = &models.RunDoc{RunID: runID, StartTime: time.Now()}
	}
	f.runs[runID].Samples = append(f.runs[runID].Samples, samples...)
	return nil
}

func (f *fakeStorage) StoreProcessInfo(runID string, processInfo models.ProcessInfo) error {
	f.storedProcessInfo = append(f.storedProcessInfo, processInfo)
	processes := f.processes[runID]
	if processes == nil {
		processes = &models.ProcessDoc{RunID: runID, ProcessInfo: make(map[string]models.ProcessInfo)}
		f.processes[runID] = processes
	}
	processes.ProcessInfo[processInfo.PID] = processInfo
	return nil
}

func (f *fakeStorage) StorePredictionCheckpoint(string, models.PredictionCheckpoint) error {
	return nil
}

func (f *fakeStorage) SetRunExportToBigquery(runID string, enabled bool) error {
	f.exportToBigQuery[runID] = enabled
	return nil
}

func (f *fakeStorage) SetRunPredictiveReliability(runID string, enabled bool) error {
	f.predictiveReliability[runID] = enabled
	return nil
}

func (f *fakeStorage) MarkRunAsFinished(runID string) (bool, error) {
	run, ok := f.runs[runID]
	if !ok {
		return false, fmt.Errorf("run %s not found", runID)
	}
	if run.Finished {
		return false, nil
	}
	run.Finished = true
	f.finishedRuns = append(f.finishedRuns, runID)
	return true, nil
}

func TestMain(m *testing.M) {
	auth.Initialize()
	os.Exit(m.Run())
}

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

func TestNewHandlersWithPredictorWiresCheckpointEvaluator(t *testing.T) {
	h := NewHandlersWithPredictor(nil, nil, predictor.NoopProvider{}, []int{60}, func(error) (string, string) {
		return "no_data", "prediction data unavailable"
	})
	if h.checkpointEvaluator == nil {
		t.Fatal("expected checkpoint evaluator to be constructed")
	}
	state, message := h.checkpointEvaluator.FallbackClassifier()(errors.New("ignored"))
	if state != "no_data" || message != "prediction data unavailable" {
		t.Fatalf("classifier = (%q, %q), want injected mapping", state, message)
	}

	h = NewHandlersWithPredictor(nil, nil, nil, nil, nil)
	err := fmt.Errorf("private stack: customer id 9: boom")
	state, message = h.checkpointEvaluator.FallbackClassifier()(err)
	if state != "provider_error" || message != "prediction provider error" {
		t.Fatalf("classifier = (%q, %q), want default public-safe mapping", state, message)
	}
	if strings.Contains(message, "customer id") || message == err.Error() {
		t.Fatal("default fallback classifier leaked private diagnostic text")
	}
}

func TestAuthUsesStoragePortForRunOptions(t *testing.T) {
	store := newFakeStorage()
	h := NewHandlers(store, nil)

	req := httptest.NewRequest(http.MethodPost, "/auth/run/run-auth?export_to_bigquery=true&predictive_reliability=true", nil)
	recorder := httptest.NewRecorder()
	h.Auth(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	if !store.exportToBigQuery["run-auth"] || !store.predictiveReliability["run-auth"] {
		t.Fatalf("auth did not persist requested run options: %#v", store)
	}
}

func TestIngestUsesStoragePortWithoutFirestore(t *testing.T) {
	store := newFakeStorage()
	h := NewHandlers(store, nil)
	const runID = "run-ingest"
	token, _, err := auth.GenerateToken(runID)
	if err != nil {
		t.Fatalf("GenerateToken failed: %v", err)
	}

	body := `{"run_id":"run-ingest","data":"00:00:01 | 12345 | GradleDaemon | 100MB | 200MB | 300MB","process_info":{"pid":"12345","name":"GradleDaemon","vm_flags":["-Xmx2g"]}}`
	req := httptest.NewRequest(http.MethodPost, "/ingest", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	h.Ingest(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s; want %d", recorder.Code, recorder.Body.String(), http.StatusOK)
	}
	if len(store.storedSamples) != 1 || len(store.storedProcessInfo) != 1 {
		t.Fatalf("stored samples/process info = %d/%d, want 1/1", len(store.storedSamples), len(store.storedProcessInfo))
	}
}

func TestGetRunUsesStoragePort(t *testing.T) {
	store := newFakeStorage()
	store.runs["run-retrieve"] = &models.RunDoc{
		RunID:    "run-retrieve",
		Samples:  []models.Sample{{PID: "12345", Name: "GradleDaemon"}},
		Finished: true,
	}
	store.processes["run-retrieve"] = &models.ProcessDoc{
		RunID: "run-retrieve",
		ProcessInfo: map[string]models.ProcessInfo{
			"12345": {PID: "12345", Name: "GradleDaemon", VMFlags: []string{"-Xmx2g"}},
		},
	}
	h := NewHandlers(store, nil)
	recorder := httptest.NewRecorder()
	h.GetRun(recorder, httptest.NewRequest(http.MethodGet, "/runs/run-retrieve", nil))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	var response models.RunResponse
	if err := json.NewDecoder(recorder.Body).Decode(&response); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(response.Samples) != 1 || response.ProcessInfo["12345"].VMFlags[0] != "-Xmx2g" {
		t.Fatalf("unexpected response: %#v", response)
	}
}

func TestValidateRunBearerToken(t *testing.T) {
	const runID = "run-bearer-auth-1"

	validToken, _, err := auth.GenerateToken(runID)
	if err != nil {
		t.Fatalf("GenerateToken failed: %v", err)
	}
	otherToken, _, err := auth.GenerateToken("other-run")
	if err != nil {
		t.Fatalf("GenerateToken for other run failed: %v", err)
	}

	tests := []struct {
		name       string
		header     string
		wantStatus int
		wantMsg    string
		wantOK     bool
	}{
		{
			name:       "missing authorization header",
			header:     "",
			wantStatus: http.StatusUnauthorized,
			wantMsg:    "Authorization header required",
		},
		{
			name:       "invalid authorization header format",
			header:     "Token " + validToken,
			wantStatus: http.StatusUnauthorized,
			wantMsg:    "Invalid authorization header format",
		},
		{
			name:       "invalid token",
			header:     "Bearer not-a-valid-token",
			wantStatus: http.StatusUnauthorized,
			wantMsg:    "Token validation failed",
		},
		{
			name:       "mismatched run id",
			header:     "Bearer " + otherToken,
			wantStatus: http.StatusUnauthorized,
			wantMsg:    "Token validation failed",
		},
		{
			name:   "valid bearer token",
			header: "Bearer " + validToken,
			wantOK: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/ingest", nil)
			if tt.header != "" {
				req.Header.Set("Authorization", tt.header)
			}

			status, message, ok := validateRunBearerToken(req, runID)
			if ok != tt.wantOK {
				t.Fatalf("ok = %v, want %v (status=%d message=%q)", ok, tt.wantOK, status, message)
			}
			if tt.wantOK {
				if status != 0 || message != "" {
					t.Fatalf("status/message = (%d, %q), want zero values on success", status, message)
				}
				return
			}
			if status != tt.wantStatus {
				t.Fatalf("status = %d, want %d", status, tt.wantStatus)
			}
			if message != tt.wantMsg {
				t.Fatalf("message = %q, want %q", message, tt.wantMsg)
			}
		})
	}
}
