package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/auth"
	"github.com/cdsap/build-process-watcher/backend/internal/cleanup"
	"github.com/cdsap/build-process-watcher/backend/internal/handlers"
	"github.com/cdsap/build-process-watcher/backend/internal/models"
	"github.com/cdsap/build-process-watcher/backend/internal/storage"
)

type muxFakeStorage struct {
	runs      map[string]*models.RunDoc
	processes map[string]*models.ProcessDoc
}

func (f *muxFakeStorage) GetRun(_ context.Context, runID string) (*models.RunDoc, error) {
	run, ok := f.runs[runID]
	if !ok {
		return nil, fmt.Errorf("%w: %s", storage.ErrRunNotFound, runID)
	}
	return run, nil
}

func (f *muxFakeStorage) GetProcesses(_ context.Context, runID string) (*models.ProcessDoc, error) {
	processes, ok := f.processes[runID]
	if !ok {
		return nil, fmt.Errorf("processes for run %s not found", runID)
	}
	return processes, nil
}

func (f *muxFakeStorage) AppendSamples(context.Context, string, storage.SampleBuildFunc) (*storage.SampleAppendResult, error) {
	return &storage.SampleAppendResult{}, nil
}
func (f *muxFakeStorage) StoreProcessInfo(context.Context, string, models.ProcessInfo) error {
	return nil
}
func (f *muxFakeStorage) StorePredictionCheckpoint(context.Context, string, models.PredictionCheckpoint) error {
	return nil
}
func (f *muxFakeStorage) AppendProcessForecasts(context.Context, string, []models.ProcessForecast) error {
	return nil
}
func (f *muxFakeStorage) SetRunExportToBigquery(context.Context, string, bool) error {
	return nil
}
func (f *muxFakeStorage) SetRunPredictiveReliability(context.Context, string, bool) error {
	return nil
}
func (f *muxFakeStorage) SetRunPredictionMode(context.Context, string, string) error {
	return nil
}
func (f *muxFakeStorage) MarkRunAsFinished(_ context.Context, runID string) (bool, error) {
	run, ok := f.runs[runID]
	if !ok {
		return false, fmt.Errorf("%w: %s", storage.ErrRunNotFound, runID)
	}
	if run.Finished {
		return false, nil
	}
	run.Finished = true
	run.FinishedAt = time.Now()
	return true, nil
}

func TestProductionMuxGetRunJSONFieldNaming(t *testing.T) {
	store := &muxFakeStorage{
		runs: map[string]*models.RunDoc{
			"run-json": {
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
			},
		},
		processes: map[string]*models.ProcessDoc{
			"run-json": {RunID: "run-json", ProcessInfo: map[string]models.ProcessInfo{}},
		},
	}
	authenticator := auth.NewForTest("mux-test-jwt", "mux-test-admin")
	h := handlers.New(handlers.Config{Storage: store, Authenticator: authenticator})
	mux := NewMux(h, cleanup.New(nil, authenticator))

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
	authenticator := auth.NewForTest("mux-test-jwt", "mux-test-admin")
	h := handlers.New(handlers.Config{Authenticator: authenticator})
	mux := NewMux(h, cleanup.New(nil, authenticator))

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
