package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/cleanup"
	"github.com/cdsap/build-process-watcher/backend/internal/handlers"
	"github.com/cdsap/build-process-watcher/backend/internal/handlers/handlertest"
	"github.com/cdsap/build-process-watcher/backend/internal/models"
)

func TestProductionMuxGetRunJSONFieldNaming(t *testing.T) {
	store := handlertest.NewFakeStorage()
	store.Runs["run-json"] = &models.RunDoc{
		RunID:     "run-json",
		UpdatedAt: time.Unix(1_700_000_000, 0).UTC(),
		Samples: []models.Sample{{
			Timestamp:   1_700_000_010_000,
			ElapsedTime: 10,
			PID:         "1",
			Name:        "GradleDaemon",
			HeapUsed:    100,
			HeapCap:     200,
			RSS:         300,
		}},
		ProcessForecasts: []models.ProcessForecast{{
			ProcessName: "GradleDaemon",
			PID:         "1",
			Metric:      "rss",
			CreatedAtMs: 1_700_000_010_000,
			Points:      []models.ProcessForecastPoint{{TargetAtMs: 1_700_000_020_000, ValueMB: 310}},
		}},
		PredictionCheckpoints: []models.PredictionCheckpoint{{
			ObservationWindowS: 60,
			Status:             "ready",
			CreatedAt:          time.Unix(1_700_000_000, 0).UTC(),
		}},
	}
	store.Processes["run-json"] = &models.ProcessDoc{RunID: "run-json", ProcessInfo: map[string]models.ProcessInfo{}}
	h := handlers.New(handlers.Config{Storage: store, Authenticator: handlertest.NewFakeRunAuthenticator()})
	mux := NewMux(h, cleanup.New(nil, nil))

	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/runs/run-json", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}

	var payload map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"samples", "process_forecasts", "prediction_checkpoints", "finished", "updated_at"} {
		if _, ok := payload[key]; !ok {
			t.Fatalf("missing top-level key %q in %s", key, rec.Body.String())
		}
	}

	var samples []map[string]any
	if err := json.Unmarshal(payload["samples"], &samples); err != nil {
		t.Fatal(err)
	}
	if len(samples) != 1 {
		t.Fatalf("samples len=%d", len(samples))
	}
	// Sample fields intentionally encode as Go default PascalCase until a
	// coordinated schema change; lock that contract here.
	for _, key := range []string{"Timestamp", "ElapsedTime", "PID", "Name", "HeapUsed", "RSS"} {
		if _, ok := samples[0][key]; !ok {
			t.Fatalf("sample missing PascalCase key %q in %#v", key, samples[0])
		}
	}
	for _, key := range []string{"timestamp", "elapsed_time", "heap_used"} {
		if _, ok := samples[0][key]; ok {
			t.Fatalf("sample unexpectedly has snake_case key %q", key)
		}
	}

	var forecasts []map[string]any
	if err := json.Unmarshal(payload["process_forecasts"], &forecasts); err != nil {
		t.Fatal(err)
	}
	if len(forecasts) != 1 {
		t.Fatalf("forecasts len=%d", len(forecasts))
	}
	for _, key := range []string{"process_name", "pid", "metric", "created_at_ms", "points"} {
		if _, ok := forecasts[0][key]; !ok {
			t.Fatalf("forecast missing snake_case key %q in %#v", key, forecasts[0])
		}
	}
}

func TestProductionMuxHealthAndAuth(t *testing.T) {
	h := handlers.New(handlers.Config{Authenticator: handlertest.NewFakeRunAuthenticator()})
	mux := NewMux(h, cleanup.New(nil, nil))

	health := httptest.NewRecorder()
	mux.ServeHTTP(health, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if health.Code != http.StatusOK {
		t.Fatalf("health status=%d", health.Code)
	}

	authRec := httptest.NewRecorder()
	mux.ServeHTTP(authRec, httptest.NewRequest(http.MethodPost, "/auth/run/run-mux", nil))
	if authRec.Code != http.StatusOK {
		t.Fatalf("auth status=%d body=%s", authRec.Code, authRec.Body.String())
	}
	var token models.TokenResponse
	if err := json.Unmarshal(authRec.Body.Bytes(), &token); err != nil || token.Token == "" {
		t.Fatalf("token response invalid: %v %s", err, authRec.Body.String())
	}
}
