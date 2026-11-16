package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/auth"
	"github.com/cdsap/build-process-watcher/backend/internal/models"
	"github.com/cdsap/build-process-watcher/backend/internal/prediction"
	"github.com/cdsap/build-process-watcher/backend/internal/predictionqueue"
	"github.com/cdsap/build-process-watcher/backend/internal/storage"
	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
)

type fakeStorage struct {
	runs                  map[string]*models.RunDoc
	processes             map[string]*models.ProcessDoc
	exportToBigQuery      map[string]bool
	predictiveReliability map[string]bool
	predictionModes       map[string]string
	getRunErr             error
	storedSamples         []models.Sample
	storedProcessInfo     []models.ProcessInfo
	appendedForecasts     []models.ProcessForecast
	finishedRuns          []string
	lastCtx               context.Context
}

type fakeForecastProvider struct {
	called    bool
	forecasts []models.ProcessForecast
}

func (f *fakeForecastProvider) Forecast(context.Context, predictor.RunSnapshot) ([]models.ProcessForecast, error) {
	f.called = true
	return f.forecasts, nil
}

type fakeExporter struct {
	runIDs []string
}

func (f *fakeExporter) Run(runID string) {
	f.runIDs = append(f.runIDs, runID)
}

func newFakeStorage() *fakeStorage {
	return &fakeStorage{
		runs:                  make(map[string]*models.RunDoc),
		processes:             make(map[string]*models.ProcessDoc),
		exportToBigQuery:      make(map[string]bool),
		predictiveReliability: make(map[string]bool),
		predictionModes:       make(map[string]string),
	}
}

func (f *fakeStorage) GetRun(ctx context.Context, runID string) (*models.RunDoc, error) {
	f.lastCtx = ctx
	if f.getRunErr != nil {
		return nil, f.getRunErr
	}
	run, ok := f.runs[runID]
	if !ok {
		return nil, fmt.Errorf("%w: %s", storage.ErrRunNotFound, runID)
	}
	return run, nil
}

func (f *fakeStorage) GetProcesses(ctx context.Context, runID string) (*models.ProcessDoc, error) {
	f.lastCtx = ctx
	processes, ok := f.processes[runID]
	if !ok {
		return nil, fmt.Errorf("processes for run %s not found", runID)
	}
	return processes, nil
}

func (f *fakeStorage) AppendSamples(_ context.Context, runID string, build storage.SampleBuildFunc) (*storage.SampleAppendResult, error) {
	existing := f.runs[runID]
	startTime := time.Now()
	if existing != nil && !existing.StartTime.IsZero() {
		startTime = existing.StartTime
	}
	samples, err := build(startTime)
	if err != nil {
		return nil, err
	}
	f.storedSamples = append(f.storedSamples, samples...)
	if existing == nil {
		existing = &models.RunDoc{RunID: runID, StartTime: startTime}
		f.runs[runID] = existing
	}
	existing.Samples = append(existing.Samples, samples...)
	return &storage.SampleAppendResult{
		Count:                 len(samples),
		PredictionMode:        existing.PredictionMode,
		PredictiveReliability: existing.PredictiveReliability,
	}, nil
}

func (f *fakeStorage) StoreProcessInfo(_ context.Context, runID string, processInfo models.ProcessInfo) error {
	f.storedProcessInfo = append(f.storedProcessInfo, processInfo)
	processes := f.processes[runID]
	if processes == nil {
		processes = &models.ProcessDoc{RunID: runID, ProcessInfo: make(map[string]models.ProcessInfo)}
		f.processes[runID] = processes
	}
	processes.ProcessInfo[processInfo.PID] = processInfo
	return nil
}

func (f *fakeStorage) StorePredictionCheckpoint(context.Context, string, models.PredictionCheckpoint) error {
	return nil
}

func (f *fakeStorage) AppendProcessForecasts(_ context.Context, _ string, forecasts []models.ProcessForecast) error {
	f.appendedForecasts = append(f.appendedForecasts, forecasts...)
	return nil
}

func (f *fakeStorage) SetRunExportToBigquery(_ context.Context, runID string, enabled bool) error {
	f.exportToBigQuery[runID] = enabled
	return nil
}

func (f *fakeStorage) SetRunPredictiveReliability(_ context.Context, runID string, enabled bool) error {
	f.predictiveReliability[runID] = enabled
	return nil
}

func (f *fakeStorage) SetRunPredictionMode(_ context.Context, runID, mode string) error {
	f.predictionModes[runID] = mode
	return nil
}

func (f *fakeStorage) MarkRunAsFinished(_ context.Context, runID string) (bool, error) {
	run, ok := f.runs[runID]
	if !ok {
		return false, fmt.Errorf("%w: %s", storage.ErrRunNotFound, runID)
	}
	if run.Finished {
		return false, nil
	}
	run.Finished = true
	f.finishedRuns = append(f.finishedRuns, runID)
	return true, nil
}

var testAuthn = auth.NewForTest("handlers-test-jwt", "handlers-test-admin")

func newTestHandlers(store Storage, export Exporter) *Handlers {
	h := NewHandlers(store, export)
	h.SetAuthenticator(testAuthn)
	return h
}

func TestMain(m *testing.M) {
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

func TestIngestDoesNotLogAuthorizationHeader(t *testing.T) {
	var buf bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(prev)

	storage := newFakeStorage()
	h := newTestHandlers(storage, nil)
	token, _, err := testAuthn.GenerateToken("run-ingest-log")
	if err != nil {
		t.Fatal(err)
	}
	body := `{"run_id":"run-ingest-log","data":"00:00:01|1|GradleDaemon|10MB|20MB|30MB|0.1s"}`
	req := httptest.NewRequest(http.MethodPost, "/ingest", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Secret-Probe", "should-never-appear")
	rr := httptest.NewRecorder()
	h.Ingest(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d body=%s", rr.Code, rr.Body.String())
	}
	logged := buf.String()
	for _, forbidden := range []string{
		"Authorization",
		"Bearer ",
		token,
		"X-Secret-Probe",
		"should-never-appear",
		"Headers:",
		"INGEST HANDLER CALLED",
		"00:00:01|1|GradleDaemon",
	} {
		if strings.Contains(logged, forbidden) {
			t.Fatalf("ingest logged sensitive marker %q in %q", forbidden, logged)
		}
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

func TestNewHandlersConfigWiresCheckpointEvaluator(t *testing.T) {
	h := New(Config{
		ReliabilityProvider: predictor.NoopProvider{},
		Checkpoints:         []int{60},
		FallbackClassifier: func(error) (string, string) {
			return "no_data", "prediction data unavailable"
		},
	})
	if h.checkpointEvaluator == nil {
		t.Fatal("expected checkpoint evaluator to be constructed")
	}
	state, message := h.checkpointEvaluator.FallbackClassifier()(errors.New("ignored"))
	if state != "no_data" || message != "prediction data unavailable" {
		t.Fatalf("classifier = (%q, %q), want injected mapping", state, message)
	}

	h = New(Config{})
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
	h := newTestHandlers(store, nil)

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
	h := newTestHandlers(store, nil)
	const runID = "run-ingest"
	token, _, err := testAuthn.GenerateToken(runID)
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

func TestIngestSchedulesPredictionWithoutRunningIt(t *testing.T) {
	store := newFakeStorage()
	const runID = "run-ingest-schedule"
	store.runs[runID] = &models.RunDoc{
		RunID:          runID,
		StartTime:      time.Unix(1_700_000_000, 0),
		PredictionMode: "predict",
	}
	h := newTestHandlers(store, nil)
	token, _, err := testAuthn.GenerateToken(runID)
	if err != nil {
		t.Fatalf("GenerateToken failed: %v", err)
	}

	var gotRun string
	var gotElapsed int
	var scheduled atomic.Bool
	h.SetPredictionScheduler(predictionqueue.Func(func(_ context.Context, id string, elapsed int) error {
		gotRun = id
		gotElapsed = elapsed
		scheduled.Store(true)
		time.Sleep(25 * time.Millisecond) // typical enqueue latency, not TabFM
		return nil
	}), "job-secret")

	body := `{"run_id":"run-ingest-schedule","data":"00:00:40 | 12345 | GradleDaemon | 100MB | 200MB | 300MB"}`
	req := httptest.NewRequest(http.MethodPost, "/ingest", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()

	start := time.Now()
	h.Ingest(recorder, req)
	took := time.Since(start)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s; want %d", recorder.Code, recorder.Body.String(), http.StatusOK)
	}
	if !scheduled.Load() || gotRun != runID {
		t.Fatalf("schedule run=%q scheduled=%v", gotRun, scheduled.Load())
	}
	if gotElapsed != 40 {
		t.Fatalf("max elapsed = %d, want 40", gotElapsed)
	}
	if took > 500*time.Millisecond {
		t.Fatalf("ingest took %s; expected enqueue-only latency", took)
	}
	if len(store.storedSamples) != 1 {
		t.Fatalf("stored samples = %d, want 1", len(store.storedSamples))
	}
}

func TestIngestSkipsPredictionScheduleWhenModeDisabled(t *testing.T) {
	cases := []struct {
		name         string
		mode         string
		reliability  bool
		wantSchedule bool
	}{
		{name: "unset", mode: "", wantSchedule: false},
		{name: "disabled", mode: "disabled", wantSchedule: false},
		{name: "predict", mode: "predict", wantSchedule: true},
		{name: "reliability flag", reliability: true, wantSchedule: true},
		{name: "reliability mode", mode: "reliability", wantSchedule: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := newFakeStorage()
			runID := "run-skip-" + tc.name
			store.runs[runID] = &models.RunDoc{
				RunID:                 runID,
				StartTime:             time.Unix(1_700_000_000, 0),
				PredictionMode:        tc.mode,
				PredictiveReliability: tc.reliability,
			}
			h := newTestHandlers(store, nil)
			token, _, err := testAuthn.GenerateToken(runID)
			if err != nil {
				t.Fatal(err)
			}
			var scheduled atomic.Bool
			h.SetPredictionScheduler(predictionqueue.Func(func(context.Context, string, int) error {
				scheduled.Store(true)
				return nil
			}), "job-secret")

			body := fmt.Sprintf(`{"run_id":%q,"data":"00:00:10 | 1 | Proc | 1MB | 2MB | 3MB"}`, runID)
			req := httptest.NewRequest(http.MethodPost, "/ingest", strings.NewReader(body))
			req.Header.Set("Authorization", "Bearer "+token)
			rec := httptest.NewRecorder()
			h.Ingest(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
			}
			if scheduled.Load() != tc.wantSchedule {
				t.Fatalf("scheduled=%v, want %v", scheduled.Load(), tc.wantSchedule)
			}
		})
	}
}

func TestEvaluatePredictionJobRequiresToken(t *testing.T) {
	store := newFakeStorage()
	h := newTestHandlers(store, nil)
	h.SetPredictionScheduler(predictionqueue.Noop{}, "job-secret")

	okReq := httptest.NewRequest(http.MethodPost, "/internal/prediction-jobs", strings.NewReader(`{"run_id":"run-job"}`))
	okReq.Header.Set(predictionqueue.JobTokenHeader, "job-secret")
	okRec := httptest.NewRecorder()
	h.EvaluatePredictionJob(okRec, okReq)
	if okRec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", okRec.Code, okRec.Body.String())
	}
	var okBody map[string]string
	if err := json.Unmarshal(okRec.Body.Bytes(), &okBody); err != nil || okBody["status"] != "success" || okBody["run_id"] != "run-job" {
		t.Fatalf("success body=%s", okRec.Body.String())
	}

	badRec := httptest.NewRecorder()
	h.EvaluatePredictionJob(badRec, httptest.NewRequest(http.MethodPost, "/internal/prediction-jobs", strings.NewReader(`{"run_id":"run-job"}`)))
	if badRec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d", badRec.Code)
	}
}

func TestEvaluatePredictionJobRunsForecastEvaluation(t *testing.T) {
	store := newFakeStorage()
	store.runs["run-job"] = &models.RunDoc{
		RunID:          "run-job",
		PredictionMode: "forecast",
		Samples:        []models.Sample{{ElapsedTime: 20}},
	}
	forecast := &fakeForecastProvider{forecasts: []models.ProcessForecast{{
		ProcessName: "GradleDaemon",
		Metric:      "rss",
		CreatedAtMs: 20_000,
	}}}
	h := New(Config{
		Storage: store,
		TimelineProviders: prediction.TimelineProviders{
			Forecast: forecast,
		},
		Authenticator:       testAuthn,
		PredictionScheduler: predictionqueue.Noop{},
		PredictionJobToken:  "job-secret",
	})

	req := httptest.NewRequest(http.MethodPost, "/internal/prediction-jobs", strings.NewReader(`{"run_id":"run-job"}`))
	req.Header.Set(predictionqueue.JobTokenHeader, "job-secret")
	recorder := httptest.NewRecorder()
	h.EvaluatePredictionJob(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", recorder.Code, recorder.Body.String())
	}
	if !forecast.called {
		t.Fatal("forecast provider was not called")
	}
	if len(store.appendedForecasts) != 1 || store.appendedForecasts[0].ProcessName != "GradleDaemon" {
		t.Fatalf("stored forecasts = %#v", store.appendedForecasts)
	}
	var response map[string]string
	if err := json.NewDecoder(recorder.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if response["status"] != "success" || response["run_id"] != "run-job" {
		t.Fatalf("response = %#v", response)
	}
}

func TestGetRunAutoFinishesStaleRuns(t *testing.T) {
	store := newFakeStorage()
	store.runs["run-stale"] = &models.RunDoc{
		RunID:     "run-stale",
		UpdatedAt: time.Now().Add(-10 * time.Minute),
		Finished:  false,
		Samples:   []models.Sample{{PID: "1", Name: "GradleDaemon"}},
	}
	store.processes["run-stale"] = &models.ProcessDoc{RunID: "run-stale", ProcessInfo: map[string]models.ProcessInfo{}}
	h := newTestHandlers(store, nil)
	rec := httptest.NewRecorder()
	h.GetRun(rec, httptest.NewRequest(http.MethodGet, "/runs/run-stale", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.finishedRuns) != 1 || store.finishedRuns[0] != "run-stale" {
		t.Fatalf("finishedRuns=%v, want [run-stale]", store.finishedRuns)
	}
	var response models.RunResponse
	if err := json.NewDecoder(rec.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if !response.Finished {
		t.Fatal("response should report finished after stale auto-finish")
	}
}

func TestIngestAttachesFreshnessReceiptMetadata(t *testing.T) {
	store := newFakeStorage()
	h := newTestHandlers(store, nil)
	const runID = "run-freshness"
	token, _, err := testAuthn.GenerateToken(runID)
	if err != nil {
		t.Fatalf("GenerateToken failed: %v", err)
	}

	body := `{"run_id":"run-freshness","data":"00:00:01 | 12345 | GradleDaemon | 100MB | 200MB | 300MB","freshness":{"sample_id":"7-12345","sequence":7,"collected_at_unix_ms":1700000000123}}`
	req := httptest.NewRequest(http.MethodPost, "/ingest", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	h.Ingest(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s; want %d", recorder.Code, recorder.Body.String(), http.StatusOK)
	}
	if len(store.storedSamples) != 1 || store.storedSamples[0].Freshness == nil {
		t.Fatalf("freshness metadata missing from stored sample: %#v", store.storedSamples)
	}
	freshness := store.storedSamples[0].Freshness
	if freshness.SampleID != "7-12345" || freshness.Sequence != 7 || freshness.CollectedAtUnixMs != 1700000000123 {
		t.Fatalf("unexpected freshness metadata: %#v", freshness)
	}
	if freshness.BackendReceivedAtUnixMs <= 0 || freshness.BackendReceivedAt.IsZero() {
		t.Fatalf("backend receipt time missing: %#v", freshness)
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
	h := newTestHandlers(store, nil)
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

func TestGetRunPassesRequestContextToStorage(t *testing.T) {
	store := newFakeStorage()
	store.runs["run-ctx"] = &models.RunDoc{RunID: "run-ctx", Finished: true}
	store.processes["run-ctx"] = &models.ProcessDoc{RunID: "run-ctx", ProcessInfo: map[string]models.ProcessInfo{}}
	h := newTestHandlers(store, nil)
	req := httptest.NewRequest(http.MethodGet, "/runs/run-ctx", nil)
	ctx, cancel := context.WithCancel(req.Context())
	cancel()
	req = req.WithContext(ctx)

	h.GetRun(httptest.NewRecorder(), req)
	if store.lastCtx == nil || store.lastCtx.Err() != context.Canceled {
		t.Fatalf("storage ctx err = %v, want context.Canceled", store.lastCtx.Err())
	}
}

func TestGetRunReturns404WhenMissing(t *testing.T) {
	h := newTestHandlers(newFakeStorage(), nil)
	recorder := httptest.NewRecorder()
	h.GetRun(recorder, httptest.NewRequest(http.MethodGet, "/runs/missing-run", nil))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d body=%s", recorder.Code, http.StatusNotFound, recorder.Body.String())
	}
}

func TestGetRunReturns500ForUnexpectedStorageErrors(t *testing.T) {
	store := newFakeStorage()
	store.getRunErr = errors.New("firestore unavailable")
	h := newTestHandlers(store, nil)
	recorder := httptest.NewRecorder()
	h.GetRun(recorder, httptest.NewRequest(http.MethodGet, "/runs/run-boom", nil))
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusInternalServerError)
	}
}

func TestFinishRunUsesExportPort(t *testing.T) {
	store := newFakeStorage()
	exporter := &fakeExporter{}
	h := newTestHandlers(store, exporter)
	const runID = "run-finish"
	store.runs[runID] = &models.RunDoc{RunID: runID}
	token, _, err := testAuthn.GenerateToken(runID)
	if err != nil {
		t.Fatalf("GenerateToken failed: %v", err)
	}

	req := httptest.NewRequest(http.MethodPost, "/finish/"+runID, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	h.FinishRun(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s; want %d", recorder.Code, recorder.Body.String(), http.StatusOK)
	}
	if len(exporter.runIDs) != 1 || exporter.runIDs[0] != runID {
		t.Fatalf("exporter run IDs = %v, want [%s]", exporter.runIDs, runID)
	}
}

func TestValidateRunBearerTokenRequiresAuthenticator(t *testing.T) {
	h := NewHandlers(nil, nil) // no authenticator injected
	req := httptest.NewRequest(http.MethodPost, "/ingest", nil)
	status, message, ok := h.validateRunBearerToken(req, "run-1")
	if ok || status != http.StatusInternalServerError || message != "Authenticator not configured" {
		t.Fatalf("got ok=%v status=%d message=%q", ok, status, message)
	}
}

func TestAuthPredictionModes(t *testing.T) {
	for _, tc := range []struct {
		query, mode string
		reliability bool
		status      int
	}{
		{"", "", false, http.StatusOK},
		{"prediction_mode=disabled", "", false, http.StatusOK},
		{"predictive_reliability=true", "reliability", true, http.StatusOK},
		{"prediction_mode=reliability", "reliability", true, http.StatusOK},
		{"prediction_mode=forecast", "forecast", false, http.StatusOK},
		{"prediction_mode=predict", "predict", false, http.StatusOK},
		{"prediction_mode=bqml-boosted", "bqml-boosted", false, http.StatusOK},
		{"prediction_mode=invalid", "", false, http.StatusBadRequest},
		{"prediction_mode=forecast&predictive_reliability=true", "", false, http.StatusBadRequest},
	} {
		t.Run(tc.query, func(t *testing.T) {
			store := newFakeStorage()
			recorder := httptest.NewRecorder()
			newTestHandlers(store, nil).Auth(recorder, httptest.NewRequest(http.MethodPost, "/auth/run/run-1?"+tc.query, nil))
			if recorder.Code != tc.status || store.predictionModes["run-1"] != tc.mode || store.predictiveReliability["run-1"] != tc.reliability {
				t.Fatalf("status=%d mode=%q reliability=%v", recorder.Code, store.predictionModes["run-1"], store.predictiveReliability["run-1"])
			}
		})
	}
}
