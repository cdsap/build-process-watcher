package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/cdsap/build-process-watcher-predictive-provider/internal/provider"
	"github.com/cdsap/build-process-watcher-predictive-provider/internal/telemetry"
	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
)

func TestHealthReturnsHealthy(t *testing.T) {
	server := NewServer(provider.New(provider.Config{}))
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()

	server.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["status"] != "healthy" {
		t.Fatalf("status body = %q, want healthy", body["status"])
	}
}

func TestPredictReturnsCheckpoint(t *testing.T) {
	server := NewServer(provider.New(provider.Config{
		ProviderID:   "provider-test",
		ModelVersion: "model-test",
	}))
	body := PredictRequest{
		ObservationWindowS: 60,
		RunID:              "run-1",
		Samples: []Sample{
			{ElapsedTime: 0, RSS: 512, HeapUsed: 300, HeapCap: 1000},
			{ElapsedTime: 60, RSS: 2048, HeapUsed: 900, HeapCap: 1000, GCTime: 9000},
		},
	}
	payload, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/predict", bytes.NewReader(payload))
	rec := httptest.NewRecorder()

	server.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	var response PredictResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Checkpoint.Status != "ready" {
		t.Fatalf("checkpoint status = %q, want ready", response.Checkpoint.Status)
	}
	if response.Checkpoint.ObservationWindowS != 60 {
		t.Fatalf("observation window = %d, want 60", response.Checkpoint.ObservationWindowS)
	}
	if response.Checkpoint.ProviderID != "provider-test" {
		t.Fatalf("provider id = %q, want provider-test", response.Checkpoint.ProviderID)
	}
	if response.Checkpoint.ModelVersion != "model-test" {
		t.Fatalf("model version = %q, want model-test", response.Checkpoint.ModelVersion)
	}
	if response.Checkpoint.RiskScore == nil {
		t.Fatal("risk score = nil, want value")
	}
	if response.Checkpoint.PredictedPeakRSSMB == nil || *response.Checkpoint.PredictedPeakRSSMB < 2048 {
		t.Fatalf("predicted peak RSS = %v, want MB-scale value", response.Checkpoint.PredictedPeakRSSMB)
	}
}

func TestPredictRejectsInvalidMethod(t *testing.T) {
	server := NewServer(provider.New(provider.Config{}))
	req := httptest.NewRequest(http.MethodGet, "/predict", nil)
	rec := httptest.NewRecorder()

	server.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusMethodNotAllowed)
	}
}

func TestPredictRejectsInvalidRequest(t *testing.T) {
	server := NewServer(provider.New(provider.Config{}))
	req := httptest.NewRequest(http.MethodPost, "/predict", bytes.NewBufferString(`{"samples":[]}`))
	rec := httptest.NewRecorder()

	server.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
	}
}

func TestPredictReturnsSkippedCheckpointWhenProviderCannotScore(t *testing.T) {
	server := NewServer(errorProvider{err: errors.New("private backend timeout: model secret details")})
	server.now = func() time.Time { return time.Unix(789, 0).UTC() }

	var logBuf bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&logBuf)
	defer log.SetOutput(prev)

	body := PredictRequest{
		ObservationWindowS: 300,
		RunID:              "run-empty",
		Samples: []Sample{
			{ElapsedTime: 300, RSS: 1024},
		},
	}
	payload, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/predict", bytes.NewReader(payload))
	rec := httptest.NewRecorder()

	server.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d: %s", rec.Code, http.StatusOK, rec.Body.String())
	}
	var response PredictResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	checkpoint := response.Checkpoint
	if checkpoint.Status != "skipped" {
		t.Fatalf("status = %q, want skipped", checkpoint.Status)
	}
	if checkpoint.ObservationWindowS != 300 {
		t.Fatalf("observation window = %d, want 300", checkpoint.ObservationWindowS)
	}
	if checkpoint.Message != "prediction provider unavailable" {
		t.Fatalf("message = %q, want generic unavailable message", checkpoint.Message)
	}
	if checkpoint.RiskLevel != "" || checkpoint.Confidence != "" || checkpoint.ProviderID != "" || checkpoint.ModelVersion != "" {
		t.Fatalf("checkpoint leaked provider/model fields: %+v", checkpoint)
	}
	if checkpoint.RiskScore != nil || checkpoint.PredictedPeakRSSMB != nil || checkpoint.PredictedDurationS != nil {
		t.Fatalf("checkpoint leaked scored fields: %+v", checkpoint)
	}
	if !checkpoint.CreatedAt.Equal(time.Unix(789, 0).UTC()) {
		t.Fatalf("created at = %v, want fixed test time", checkpoint.CreatedAt)
	}

	stats := server.Telemetry().Snapshot()
	if len(stats) != 1 || stats[0].Fallback != 1 || stats[0].ProviderError != 1 {
		t.Fatalf("fallback stats = %+v", stats)
	}
	if stats[0].ModelVersion != "api-fallback" {
		t.Fatalf("fallback model version = %q, want api-fallback", stats[0].ModelVersion)
	}
	if !strings.Contains(logBuf.String(), "outcome=fallback") || !strings.Contains(logBuf.String(), "state=provider_error") {
		t.Fatalf("logs missing fallback telemetry: %s", logBuf.String())
	}
	if strings.Contains(rec.Body.String(), "model secret") {
		t.Fatalf("HTTP body leaked private diagnostic: %s", rec.Body.String())
	}
}

func TestPredictFallbackTelemetryClassifiesProviderSentinels(t *testing.T) {
	cases := []struct {
		name      string
		err       error
		wantState telemetry.State
	}{
		{name: "no-data", err: provider.ErrNoData, wantState: telemetry.StateNoData},
		{name: "timeout", err: provider.ErrScoringTimeout, wantState: telemetry.StateModelUnavailable},
		{name: "model-unavailable", err: provider.ErrModelUnavailable, wantState: telemetry.StateModelUnavailable},
		{name: "provider-error", err: provider.ErrScoringFailed, wantState: telemetry.StateProviderError},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := NewServer(errorProvider{err: tc.err})
			body := PredictRequest{
				ObservationWindowS: 60,
				RunID:              "run-" + tc.name,
				Samples:            []Sample{{ElapsedTime: 60, RSS: 512}},
			}
			payload, err := json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
			req := httptest.NewRequest(http.MethodPost, "/predict", bytes.NewReader(payload))
			rec := httptest.NewRecorder()
			server.Handler().ServeHTTP(rec, req)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
			}
			stats := server.Telemetry().Snapshot()
			if len(stats) != 1 || stats[0].Fallback != 1 {
				t.Fatalf("stats = %+v, want one fallback", stats)
			}
			switch tc.wantState {
			case telemetry.StateNoData:
				if stats[0].NoData != 1 {
					t.Fatalf("stats = %+v, want no_data=1", stats[0])
				}
			case telemetry.StateModelUnavailable:
				if stats[0].ModelUnavailable != 1 {
					t.Fatalf("stats = %+v, want model_unavailable=1", stats[0])
				}
			case telemetry.StateProviderError:
				if stats[0].ProviderError != 1 {
					t.Fatalf("stats = %+v, want provider_error=1", stats[0])
				}
			}
			if strings.Contains(rec.Body.String(), "scoring") || strings.Contains(rec.Body.String(), "snapshot") {
				t.Fatalf("HTTP body leaked private sentinel detail: %s", rec.Body.String())
			}
		})
	}
}

func TestLocalSmokeScoredAndSafeFallbackCheckpoint(t *testing.T) {
	liveProvider := provider.New(provider.Config{
		ProviderID:   "smoke-provider",
		ModelVersion: "smoke-model",
	})
	server := NewServer(liveProvider)

	readyBody := PredictRequest{
		ObservationWindowS: 60,
		RunID:              "smoke-run",
		Samples: []Sample{
			{ElapsedTime: 0, RSS: 512, HeapUsed: 300, HeapCap: 1000},
			{ElapsedTime: 60, RSS: 2048, HeapUsed: 900, HeapCap: 1000, GCTime: 9000},
		},
	}
	readyPayload, err := json.Marshal(readyBody)
	if err != nil {
		t.Fatal(err)
	}
	readyReq := httptest.NewRequest(http.MethodPost, "/predict", bytes.NewReader(readyPayload))
	readyRec := httptest.NewRecorder()
	server.Handler().ServeHTTP(readyRec, readyReq)
	if readyRec.Code != http.StatusOK {
		t.Fatalf("scored status = %d, want %d: %s", readyRec.Code, http.StatusOK, readyRec.Body.String())
	}
	var readyResp PredictResponse
	if err := json.Unmarshal(readyRec.Body.Bytes(), &readyResp); err != nil {
		t.Fatal(err)
	}
	if readyResp.Checkpoint.Status != "ready" {
		t.Fatalf("scored checkpoint status = %q, want ready", readyResp.Checkpoint.Status)
	}
	if readyResp.Checkpoint.Message != "private predictive provider evaluated runtime telemetry" {
		t.Fatalf("scored message = %q, want public-safe runtime message", readyResp.Checkpoint.Message)
	}
	if strings.Contains(readyResp.Checkpoint.Message, "bigquery") || strings.Contains(readyResp.Checkpoint.Message, "diagnostic") {
		t.Fatalf("scored message leaked private context: %q", readyResp.Checkpoint.Message)
	}

	failing := NewServer(errorProvider{err: errors.New("bigquery ml private detail: deadline exceeded upstream")})
	failing.now = func() time.Time { return time.Unix(1000, 0).UTC() }
	fallbackBody := PredictRequest{
		ObservationWindowS: 300,
		RunID:              "smoke-fallback",
		Samples:            []Sample{{ElapsedTime: 300, RSS: 1024}},
	}
	fallbackPayload, err := json.Marshal(fallbackBody)
	if err != nil {
		t.Fatal(err)
	}
	fallbackReq := httptest.NewRequest(http.MethodPost, "/predict", bytes.NewReader(fallbackPayload))
	fallbackRec := httptest.NewRecorder()
	failing.Handler().ServeHTTP(fallbackRec, fallbackReq)
	if fallbackRec.Code != http.StatusOK {
		t.Fatalf("fallback status = %d, want %d: %s", fallbackRec.Code, http.StatusOK, fallbackRec.Body.String())
	}
	var fallbackResp PredictResponse
	if err := json.Unmarshal(fallbackRec.Body.Bytes(), &fallbackResp); err != nil {
		t.Fatal(err)
	}
	if fallbackResp.Checkpoint.Status != "skipped" {
		t.Fatalf("fallback status = %q, want skipped", fallbackResp.Checkpoint.Status)
	}
	if fallbackResp.Checkpoint.Message != "prediction provider unavailable" {
		t.Fatalf("fallback message = %q, want public-safe unavailable message", fallbackResp.Checkpoint.Message)
	}
	if strings.Contains(fallbackRec.Body.String(), "bigquery") || strings.Contains(fallbackRec.Body.String(), "deadline exceeded upstream") {
		t.Fatalf("fallback response leaked private scoring detail: %s", fallbackRec.Body.String())
	}

	telemetrySnap := liveProvider.Telemetry().Snapshot()
	if len(telemetrySnap) != 1 || telemetrySnap[0].Success != 1 || telemetrySnap[0].ObservationWindowS != 60 {
		t.Fatalf("smoke telemetry = %+v, want one successful 60s attempt", telemetrySnap)
	}

	fallbackStats := failing.Telemetry().Snapshot()
	if len(fallbackStats) != 1 || fallbackStats[0].Fallback != 1 || fallbackStats[0].ProviderError != 1 {
		t.Fatalf("smoke fallback telemetry = %+v, want one provider-error fallback", fallbackStats)
	}
}

type errorProvider struct {
	err error
}

func (p errorProvider) Predict(context.Context, predictor.RunSnapshot, int) (predictor.PredictionCheckpoint, error) {
	return predictor.PredictionCheckpoint{}, p.err
}
