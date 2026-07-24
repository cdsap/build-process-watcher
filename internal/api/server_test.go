package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/cdsap/build-process-watcher-predictive-provider/internal/provider"
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
			{ElapsedTime: 0, RSS: 512 * 1024, HeapUsed: 300, HeapCap: 1000},
			{ElapsedTime: 60, RSS: 2048 * 1024, HeapUsed: 900, HeapCap: 1000, GCTime: 9000},
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

func TestPredictReturnsUnprocessableWhenProviderCannotScore(t *testing.T) {
	server := NewServer(provider.New(provider.Config{}))
	body := PredictRequest{
		ObservationWindowS: 30,
		RunID:              "run-empty",
	}
	payload, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/predict", bytes.NewReader(payload))
	rec := httptest.NewRecorder()

	server.Handler().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnprocessableEntity)
	}
}
