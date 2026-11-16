package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/cdsap/build-process-watcher/backend/internal/cleanup"
	"github.com/cdsap/build-process-watcher/backend/internal/handlers"
	"github.com/cdsap/build-process-watcher/backend/internal/predictionqueue"
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

func TestBuildOptionsNormalizesProviderAndCheckpoints(t *testing.T) {
	tests := []struct {
		name                 string
		providerEnabled      bool
		providerURL          string
		checkpoints          string
		wantProviderEnabled  bool
		wantCheckpoints      []int
		wantProviderBuildErr bool
	}{
		{
			name:            "disabled provider",
			wantCheckpoints: nil,
		},
		{
			name:                 "missing provider URL",
			providerEnabled:      true,
			wantProviderBuildErr: true,
			wantCheckpoints:      nil,
		},
		{
			name:                "default checkpoints",
			providerEnabled:     true,
			providerURL:         "http://127.0.0.1:8081",
			checkpoints:         "",
			wantProviderEnabled: true,
			wantCheckpoints:     []int{60, 300, 600, 1200},
		},
		{
			name:                "explicit checkpoints",
			providerEnabled:     true,
			providerURL:         "http://127.0.0.1:8081",
			checkpoints:         "30,60,bad,60",
			wantProviderEnabled: true,
			wantCheckpoints:     []int{30, 60},
		},
		{
			name:            "invalid checkpoints",
			checkpoints:     "bad,0",
			wantCheckpoints: nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			options, err := buildOptions(serverConfig{
				predictionProviderEnabled: tt.providerEnabled,
				predictionProviderURL:     tt.providerURL,
				predictionCheckpoints:     tt.checkpoints,
			})
			if (err != nil) != tt.wantProviderBuildErr {
				t.Fatalf("buildOptions error = %v, want error: %t", err, tt.wantProviderBuildErr)
			}
			if predictor.Enabled(options.PredictionProvider) != tt.wantProviderEnabled {
				t.Fatalf("provider enabled = %t, want %t", predictor.Enabled(options.PredictionProvider), tt.wantProviderEnabled)
			}
			if len(options.PredictionCheckpoints) != len(tt.wantCheckpoints) {
				t.Fatalf("PredictionCheckpoints = %v, want %v", options.PredictionCheckpoints, tt.wantCheckpoints)
			}
			for i, want := range tt.wantCheckpoints {
				if options.PredictionCheckpoints[i] != want {
					t.Fatalf("PredictionCheckpoints = %v, want %v", options.PredictionCheckpoints, tt.wantCheckpoints)
				}
			}
		})
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

func TestOptionsFromEnvLoadsPredictionQueueSettings(t *testing.T) {
	t.Setenv("PREDICTION_TASKS_QUEUE", " pred-queue ")
	t.Setenv("PREDICTION_TASKS_LOCATION", " europe-west1 ")
	t.Setenv("PREDICTION_JOB_URL", " https://example.test/internal/prediction-jobs ")
	t.Setenv("PREDICTION_JOB_TOKEN", " secret-token ")

	options := OptionsFromEnv()

	if options.PredictionTasksQueue != "pred-queue" {
		t.Fatalf("PredictionTasksQueue = %q, want pred-queue", options.PredictionTasksQueue)
	}
	if options.PredictionTasksLocation != "europe-west1" {
		t.Fatalf("PredictionTasksLocation = %q, want europe-west1", options.PredictionTasksLocation)
	}
	if options.PredictionJobURL != "https://example.test/internal/prediction-jobs" {
		t.Fatalf("PredictionJobURL = %q", options.PredictionJobURL)
	}
	if options.PredictionJobToken != "secret-token" {
		t.Fatalf("PredictionJobToken = %q, want secret-token", options.PredictionJobToken)
	}
}

func TestOptionsFromEnvDefaultsPredictionTasksLocation(t *testing.T) {
	t.Setenv("PREDICTION_TASKS_LOCATION", "")
	options := OptionsFromEnv()
	if options.PredictionTasksLocation != "us-central1" {
		t.Fatalf("PredictionTasksLocation = %q, want us-central1", options.PredictionTasksLocation)
	}
}

func TestOptionsFromEnvTimelineProvidersFallBackToSharedEnabledFlag(t *testing.T) {
	t.Setenv("PREDICTIVE_PROVIDER_ENABLED", "true")
	t.Setenv(providerEnv("URL"), "http://127.0.0.1:8081")
	t.Setenv("PREDICTIVE_FORECAST_PROVIDER_ENABLED", "")
	t.Setenv("PREDICTIVE_TABPREDICT_PROVIDER_ENABLED", "")
	t.Setenv("PREDICTIVE_BQML_BOOSTED_PROVIDER_ENABLED", "")

	options := OptionsFromEnv()

	if !predictor.ForecastEnabled(options.ForecastProvider) {
		t.Fatal("forecast provider should inherit PREDICTIVE_PROVIDER_ENABLED")
	}
	if !predictor.ForecastEnabled(options.TabPredictProvider) {
		t.Fatal("tabpredict provider should inherit PREDICTIVE_PROVIDER_ENABLED")
	}
	if !predictor.ForecastEnabled(options.BQMLBoostedProvider) {
		t.Fatal("bqml-boosted provider should inherit PREDICTIVE_PROVIDER_ENABLED")
	}
}

func TestBuildOptionsTableDrivesTimelineProviders(t *testing.T) {
	options, err := buildOptions(serverConfig{
		predictionProviderURL:      "http://127.0.0.1:8081",
		forecastProviderEnabled:    true,
		tabPredictProviderEnabled:  true,
		bqmlBoostedProviderEnabled: true,
	})
	if err != nil {
		t.Fatalf("buildOptions: %v", err)
	}
	if !predictor.ForecastEnabled(options.ForecastProvider) {
		t.Fatal("forecast provider should be enabled")
	}
	if !predictor.ForecastEnabled(options.TabPredictProvider) {
		t.Fatal("tabpredict provider should be enabled")
	}
	if !predictor.ForecastEnabled(options.BQMLBoostedProvider) {
		t.Fatal("bqml-boosted provider should be enabled")
	}
	if got := len(timelineProviderSpecs(serverConfig{})); got != 3 {
		t.Fatalf("timelineProviderSpecs len = %d, want 3 (one per timeline mode)", got)
	}
}

func TestBuildOptionsLeavesTimelineProvidersNoopWhenDisabled(t *testing.T) {
	options, err := buildOptions(serverConfig{
		predictionProviderURL: "http://127.0.0.1:8081",
	})
	if err != nil {
		t.Fatalf("buildOptions: %v", err)
	}
	if predictor.ForecastEnabled(options.ForecastProvider) {
		t.Fatal("forecast should stay noop when disabled")
	}
	if predictor.ForecastEnabled(options.TabPredictProvider) {
		t.Fatal("tabpredict should stay noop when disabled")
	}
	if predictor.ForecastEnabled(options.BQMLBoostedProvider) {
		t.Fatal("bqml-boosted should stay noop when disabled")
	}
}

func TestNewPredictionSchedulerDisabledWithoutQueueSettings(t *testing.T) {
	sched, closer := newPredictionScheduler(context.Background(), Options{
		ProjectID: "project-1",
	})
	if closer != nil {
		t.Fatal("closer should be nil when queue is disabled")
	}
	if _, ok := sched.(predictionqueue.Noop); !ok {
		t.Fatalf("scheduler type = %T, want predictionqueue.Noop", sched)
	}
}

func TestNewMuxRegistersPublicRoutes(t *testing.T) {
	mux := NewMux(handlers.NewHandlers(nil, nil), cleanup.NewService(nil, nil))

	for _, route := range []string{"/healthz", "/auth/run/run-1", "/ingest", "/internal/prediction-jobs", "/runs/run-1", "/finish/run-1", "/cleanup/stale", "/test"} {
		request := httptest.NewRequest(http.MethodOptions, route, nil)
		recorder := httptest.NewRecorder()

		mux.ServeHTTP(recorder, request)

		if recorder.Code == http.StatusNotFound {
			t.Fatalf("route %s was not registered", route)
		}
	}
}
