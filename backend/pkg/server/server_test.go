package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/cdsap/build-process-watcher/backend/internal/cleanup"
	"github.com/cdsap/build-process-watcher/backend/internal/handlers"
	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
)

type fakeProvider struct{}

func (fakeProvider) Predict(context.Context, predictor.RunSnapshot, int) (predictor.PredictionCheckpoint, error) {
	return predictor.PredictionCheckpoint{}, nil
}

func providerEnv(suffix string) string {
	return "PREDICTIVE_PROVIDER_" + suffix
}

func TestOptionsFromEnvUsesPublicNoopProvider(t *testing.T) {
	t.Setenv("GOOGLE_CLOUD_PROJECT", "project-1")
	t.Setenv("PORT", "")
	t.Setenv("BIGQUERY_EXPORT_DATASET", " dataset_1 ")
	t.Setenv("BIGQUERY_EXPORT_TABLE", " samples_1 ")
	t.Setenv("BIGQUERY_EXPORT_PROCESSES_TABLE", " processes_1 ")
	t.Setenv("PREDICTIVE_RELIABILITY_CHECKPOINTS", "30,60,bad,180")

	options := OptionsFromEnv()

	if options.ProjectID != "project-1" {
		t.Fatalf("ProjectID = %q, want project-1", options.ProjectID)
	}
	if options.Port != "8080" {
		t.Fatalf("Port = %q, want 8080", options.Port)
	}
	if options.BigQueryDataset != "dataset_1" {
		t.Fatalf("BigQueryDataset = %q, want dataset_1", options.BigQueryDataset)
	}
	if options.BigQueryTable != "samples_1" {
		t.Fatalf("BigQueryTable = %q, want samples_1", options.BigQueryTable)
	}
	if options.BigQueryProcessesTable != "processes_1" {
		t.Fatalf("BigQueryProcessesTable = %q, want processes_1", options.BigQueryProcessesTable)
	}
	if predictor.Enabled(options.PredictionProvider) {
		t.Fatal("OptionsFromEnv should default to the public no-op provider")
	}
	if got := options.PredictionCheckpoints; len(got) != 3 || got[0] != 30 || got[1] != 60 || got[2] != 180 {
		t.Fatalf("PredictionCheckpoints = %v, want [30 60 180]", got)
	}
}

func TestOptionsFromEnvUsesNoopWhenRemoteProviderDisabled(t *testing.T) {
	t.Setenv("PREDICTIVE_PROVIDER_ENABLED", "false")
	t.Setenv(providerEnv("URL"), "http://127.0.0.1:8081")
	t.Setenv("PREDICTIVE_RELIABILITY_CHECKPOINTS", "")

	options := OptionsFromEnv()

	if predictor.Enabled(options.PredictionProvider) {
		t.Fatal("provider should remain no-op when remote feature flag is false")
	}
	if len(options.PredictionCheckpoints) != 0 {
		t.Fatalf("PredictionCheckpoints = %v, want empty", options.PredictionCheckpoints)
	}
}

func TestOptionsFromEnvUsesNoopWhenRemoteProviderURLMissing(t *testing.T) {
	t.Setenv("PREDICTIVE_PROVIDER_ENABLED", "true")
	t.Setenv(providerEnv("URL"), "")
	t.Setenv("PREDICTIVE_RELIABILITY_CHECKPOINTS", "")

	options := OptionsFromEnv()

	if predictor.Enabled(options.PredictionProvider) {
		t.Fatal("provider should remain no-op when remote URL is missing")
	}
	if len(options.PredictionCheckpoints) != 0 {
		t.Fatalf("PredictionCheckpoints = %v, want empty", options.PredictionCheckpoints)
	}
}

func TestOptionsFromEnvUsesRemoteProviderWithDefaultCheckpointsWhenEnabled(t *testing.T) {
	t.Setenv("PREDICTIVE_PROVIDER_ENABLED", "true")
	t.Setenv(providerEnv("URL"), "http://127.0.0.1:8081")
	t.Setenv(providerEnv("TIMEOUT_MS"), "2500")
	t.Setenv("PREDICTIVE_RELIABILITY_CHECKPOINTS", "")

	options := OptionsFromEnv()

	if !predictor.Enabled(options.PredictionProvider) {
		t.Fatal("remote provider should be enabled")
	}
	if _, ok := options.PredictionProvider.(*predictor.RemoteProvider); !ok {
		t.Fatalf("provider type = %T, want *predictor.RemoteProvider", options.PredictionProvider)
	}
	expected := []int{60, 300, 600, 1200}
	if got := options.PredictionCheckpoints; len(got) != len(expected) {
		t.Fatalf("PredictionCheckpoints = %v, want %v", got, expected)
	} else {
		for i := range expected {
			if got[i] != expected[i] {
				t.Fatalf("PredictionCheckpoints = %v, want %v", got, expected)
			}
		}
	}
}

func TestOptionsFromEnvKeepsExplicitCheckpointsWhenRemoteProviderEnabled(t *testing.T) {
	t.Setenv("PREDICTIVE_PROVIDER_ENABLED", "true")
	t.Setenv(providerEnv("URL"), "http://127.0.0.1:8081")
	t.Setenv("PREDICTIVE_RELIABILITY_CHECKPOINTS", "30,60,bad,60")

	options := OptionsFromEnv()

	expected := []int{30, 60}
	if got := options.PredictionCheckpoints; len(got) != len(expected) {
		t.Fatalf("PredictionCheckpoints = %v, want %v", got, expected)
	} else {
		for i := range expected {
			if got[i] != expected[i] {
				t.Fatalf("PredictionCheckpoints = %v, want %v", got, expected)
			}
		}
	}
}

func TestOptionsFromEnvDoesNotDefaultInvalidExplicitCheckpoints(t *testing.T) {
	t.Setenv("PREDICTIVE_PROVIDER_ENABLED", "true")
	t.Setenv(providerEnv("URL"), "http://127.0.0.1:8081")
	t.Setenv("PREDICTIVE_RELIABILITY_CHECKPOINTS", "bad,0")

	options := OptionsFromEnv()

	if got := options.PredictionCheckpoints; len(got) != 0 {
		t.Fatalf("PredictionCheckpoints = %v, want empty for invalid explicit config", got)
	}
}

func TestOptionsCanCarryInjectedProvider(t *testing.T) {
	options := Options{PredictionProvider: fakeProvider{}}
	if !predictor.Enabled(options.PredictionProvider) {
		t.Fatal("injected provider should be enabled")
	}
}

func TestOptionsCanCarryFallbackClassifier(t *testing.T) {
	options := Options{
		FallbackClassifier: func(error) (string, string) {
			return "no_data", "prediction data unavailable"
		},
	}
	if options.FallbackClassifier == nil {
		t.Fatal("FallbackClassifier should be injectable on Options")
	}
	state, message := options.FallbackClassifier(nil)
	if state != "no_data" || message != "prediction data unavailable" {
		t.Fatalf("classifier = (%q, %q), want no_data / prediction data unavailable", state, message)
	}
}

func TestOptionsFromEnvLeavesFallbackClassifierUnset(t *testing.T) {
	t.Setenv("PREDICTIVE_PROVIDER_ENABLED", "false")
	options := OptionsFromEnv()
	if options.FallbackClassifier != nil {
		t.Fatal("OptionsFromEnv should leave FallbackClassifier unset for composition-root wiring")
	}
}

func TestNewMuxRegistersPublicRoutes(t *testing.T) {
	mux := NewMux(handlers.NewHandlers(nil, nil), cleanup.NewService(nil, nil))

	for _, route := range []string{"/healthz", "/auth/run/run-1", "/ingest", "/runs/run-1", "/finish/run-1", "/cleanup/stale", "/test"} {
		request := httptest.NewRequest(http.MethodOptions, route, nil)
		recorder := httptest.NewRecorder()

		mux.ServeHTTP(recorder, request)

		if recorder.Code == http.StatusNotFound {
			t.Fatalf("route %s was not registered", route)
		}
	}
}
