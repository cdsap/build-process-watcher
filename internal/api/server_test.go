package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/cdsap/build-process-watcher-predictive-provider/internal/provider"
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
}

type errorProvider struct {
	err error
}

func (p errorProvider) Predict(context.Context, predictor.RunSnapshot, int) (predictor.PredictionCheckpoint, error) {
	return predictor.PredictionCheckpoint{}, p.err
}
