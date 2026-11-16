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
	"github.com/cdsap/build-process-watcher/backend/internal/handlers/handlertest"
	"github.com/cdsap/build-process-watcher/backend/internal/models"
	"github.com/cdsap/build-process-watcher/backend/internal/prediction"
	"github.com/cdsap/build-process-watcher/backend/internal/predictionqueue"
	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
)

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

type fakeStorage = handlertest.FakeStorage

func newFakeStorage() *fakeStorage {
	return handlertest.NewFakeStorage()
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
	request := httptest.NewRequest("POST", "/auth/run/run-1?export_to_bigquery=true", nil)
	if !boolQuery(request, "export_to_bigquery") {
		t.Fatal("expected export_to_bigquery=true to be accepted")
	}
	request = httptest.NewRequest("POST", "/auth/run/run-1?export_to_bigquery=false", nil)
	if boolQuery(request, "export_to_bigquery") {
		t.Fatal("expected export_to_bigquery=false to be rejected")
	}
	request = httptest.NewRequest("POST", "/auth/run/run-1?export_to_bigquery=maybe", nil)
	if boolQuery(request, "export_to_bigquery") {
		t.Fatal("expected invalid export_to_bigquery value to be rejected")
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

func TestNewHandlersConfigWiresForecastEvaluator(t *testing.T) {
	h := New(Config{})
	if h.forecastEvaluator == nil {
		t.Fatal("expected forecast evaluator to be constructed")
	}
}

func TestAuthUsesStoragePortForRunOptions(t *testing.T) {
	store := newFakeStorage()
	h := newTestHandlers(store, nil)

	req := httptest.NewRequest(http.MethodPost, "/auth/run/run-auth?export_to_bigquery=true&prediction_mode=forecast", nil)
	recorder := httptest.NewRecorder()
	h.Auth(recorder, req)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusOK)
	}
	if !store.ExportToBigQuery["run-auth"] {
		t.Fatalf("auth did not persist export_to_bigquery: %#v", store.ExportToBigQuery)
	}
	if store.PredictionModes["run-auth"] != "forecast" {
		t.Fatalf("prediction mode = %q, want forecast", store.PredictionModes["run-auth"])
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
	if len(store.StoredSamples) != 1 || len(store.StoredProcessInfo) != 1 {
		t.Fatalf("stored samples/process info = %d/%d, want 1/1", len(store.StoredSamples), len(store.StoredProcessInfo))
	}
}

func TestIngestSchedulesPredictionWithoutRunningIt(t *testing.T) {
	store := newFakeStorage()
	const runID = "run-ingest-schedule"
	store.Runs[runID] = &models.RunDoc{
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
	if len(store.StoredSamples) != 1 {
		t.Fatalf("stored samples = %d, want 1", len(store.StoredSamples))
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
		{name: "legacy reliability flag ignored", reliability: true, wantSchedule: false},
		{name: "retired reliability mode ignored", mode: "reliability", wantSchedule: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := newFakeStorage()
			runID := "run-skip-" + tc.name
			store.Runs[runID] = &models.RunDoc{
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
	store.Runs["run-job"] = &models.RunDoc{
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
	if len(store.AppendedForecasts) != 1 || store.AppendedForecasts[0].ProcessName != "GradleDaemon" {
		t.Fatalf("stored forecasts = %#v", store.AppendedForecasts)
	}
	var response map[string]string
	if err := json.NewDecoder(recorder.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if response["status"] != "success" || response["run_id"] != "run-job" {
		t.Fatalf("response = %#v", response)
	}
}

func TestEvaluatePredictionJobLoadsRunOnce(t *testing.T) {
	store := newFakeStorage()
	store.Runs["run-job"] = &models.RunDoc{
		RunID:          "run-job",
		PredictionMode: "forecast",
		Samples:        []models.Sample{{ElapsedTime: 40, Timestamp: 40000}},
	}
	forecast := &fakeForecastProvider{forecasts: []models.ProcessForecast{{
		ProcessName: "GradleDaemon",
		Metric:      "rss",
		CreatedAtMs: 40_000,
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
	if store.GetRunCalls != 1 {
		t.Fatalf("GetRun calls = %d, want 1 for prediction job success path", store.GetRunCalls)
	}
	if !forecast.called {
		t.Fatal("forecast provider was not called")
	}
}

func TestGetRunAutoFinishesStaleRuns(t *testing.T) {
	store := newFakeStorage()
	store.Runs["run-stale"] = &models.RunDoc{
		RunID:     "run-stale",
		UpdatedAt: time.Now().Add(-10 * time.Minute),
		Finished:  false,
		Samples:   []models.Sample{{PID: "1", Name: "GradleDaemon"}},
	}
	store.Processes["run-stale"] = &models.ProcessDoc{RunID: "run-stale", ProcessInfo: map[string]models.ProcessInfo{}}
	h := newTestHandlers(store, nil)
	rec := httptest.NewRecorder()
	h.GetRun(rec, httptest.NewRequest(http.MethodGet, "/runs/run-stale", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if len(store.FinishedRuns) != 1 || store.FinishedRuns[0] != "run-stale" {
		t.Fatalf("finishedRuns=%v, want [run-stale]", store.FinishedRuns)
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
	if len(store.StoredSamples) != 1 || store.StoredSamples[0].Freshness == nil {
		t.Fatalf("freshness metadata missing from stored sample: %#v", store.StoredSamples)
	}
	freshness := store.StoredSamples[0].Freshness
	if freshness.SampleID != "7-12345" || freshness.Sequence != 7 || freshness.CollectedAtUnixMs != 1700000000123 {
		t.Fatalf("unexpected freshness metadata: %#v", freshness)
	}
	if freshness.BackendReceivedAtUnixMs <= 0 || freshness.BackendReceivedAt.IsZero() {
		t.Fatalf("backend receipt time missing: %#v", freshness)
	}
}

func TestGetRunUsesStoragePort(t *testing.T) {
	store := newFakeStorage()
	store.Runs["run-retrieve"] = &models.RunDoc{
		RunID:    "run-retrieve",
		Samples:  []models.Sample{{PID: "12345", Name: "GradleDaemon"}},
		Finished: true,
	}
	store.Processes["run-retrieve"] = &models.ProcessDoc{
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
	store.Runs["run-ctx"] = &models.RunDoc{RunID: "run-ctx", Finished: true}
	store.Processes["run-ctx"] = &models.ProcessDoc{RunID: "run-ctx", ProcessInfo: map[string]models.ProcessInfo{}}
	h := newTestHandlers(store, nil)
	req := httptest.NewRequest(http.MethodGet, "/runs/run-ctx", nil)
	ctx, cancel := context.WithCancel(req.Context())
	cancel()
	req = req.WithContext(ctx)

	h.GetRun(httptest.NewRecorder(), req)
	if store.LastCtx == nil || store.LastCtx.Err() != context.Canceled {
		t.Fatalf("storage ctx err = %v, want context.Canceled", store.LastCtx.Err())
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
	store.GetRunErr = errors.New("firestore unavailable")
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
	store.Runs[runID] = &models.RunDoc{RunID: runID}
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

func TestAuthUsesFakeRunAuthenticator(t *testing.T) {
	store := newFakeStorage()
	fakeAuth := &handlertest.FakeAuthenticator{Token: "mux-fake-token"}
	h := New(Config{Storage: store, Authenticator: fakeAuth})

	rec := httptest.NewRecorder()
	h.Auth(rec, httptest.NewRequest(http.MethodGet, "/auth/run/run-fake", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var resp models.TokenResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Token != "mux-fake-token" {
		t.Fatalf("token = %q, want mux-fake-token", resp.Token)
	}

	ingestRec := httptest.NewRecorder()
	ingestReq := httptest.NewRequest(http.MethodPost, "/ingest", strings.NewReader(`{"run_id":"run-fake","process_info":{"pid":"1","name":"GradleDaemon"}}`))
	ingestReq.Header.Set("Authorization", "Bearer mux-fake-token")
	ingestReq.Header.Set("Content-Type", "application/json")
	h.Ingest(ingestRec, ingestReq)
	if ingestRec.Code != http.StatusOK {
		t.Fatalf("ingest status = %d body=%s", ingestRec.Code, ingestRec.Body.String())
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
		query  string
		mode   string
		status int
	}{
		{"", "", http.StatusOK},
		{"prediction_mode=disabled", "", http.StatusOK},
		{"prediction_mode=forecast", "forecast", http.StatusOK},
		{"prediction_mode=predict", "predict", http.StatusOK},
		{"prediction_mode=bqml-boosted", "bqml-boosted", http.StatusOK},
		{"prediction_mode=reliability", "", http.StatusBadRequest},
		{"predictive_reliability=true", "", http.StatusBadRequest},
		{"prediction_mode=invalid", "", http.StatusBadRequest},
	} {
		t.Run(tc.query, func(t *testing.T) {
			store := newFakeStorage()
			recorder := httptest.NewRecorder()
			newTestHandlers(store, nil).Auth(recorder, httptest.NewRequest(http.MethodPost, "/auth/run/run-1?"+tc.query, nil))
			if recorder.Code != tc.status || store.PredictionModes["run-1"] != tc.mode {
				t.Fatalf("status=%d mode=%q want status=%d mode=%q", recorder.Code, store.PredictionModes["run-1"], tc.status, tc.mode)
			}
		})
	}
}
