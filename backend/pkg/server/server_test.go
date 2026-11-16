package server

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/bigqueryexport"
	"github.com/cdsap/build-process-watcher/backend/internal/cleanup"
	"github.com/cdsap/build-process-watcher/backend/internal/handlers"
	"github.com/cdsap/build-process-watcher/backend/internal/predictionqueue"
	"github.com/cdsap/build-process-watcher/backend/internal/storage"
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

func TestNewMuxRegistersPublicRoutes(t *testing.T) {
	mux := NewMux(handlers.NewHandlers(nil, nil), cleanup.NewService(nil, nil))

	for _, route := range []string{"/healthz", "/auth/run/run-1", "/ingest", "/internal/prediction-jobs", "/runs/run-1", "/finish/run-1", "/cleanup/stale"} {
		request := httptest.NewRequest(http.MethodOptions, route, nil)
		recorder := httptest.NewRecorder()

		mux.ServeHTTP(recorder, request)

		if recorder.Code == http.StatusNotFound {
			t.Fatalf("route %s was not registered", route)
		}
	}
}

func TestNewMuxDoesNotRegisterTestRoute(t *testing.T) {
	mux := NewMux(handlers.NewHandlers(nil, nil), cleanup.NewService(nil, nil))

	request := httptest.NewRequest(http.MethodGet, "/test", nil)
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("/test status = %d, want 404", recorder.Code)
	}
}

func TestMonitoredEndpointsMatchMux(t *testing.T) {
	mux := NewMux(handlers.NewHandlers(nil, nil), cleanup.NewService(nil, nil))
	for _, endpoint := range monitoredEndpoints {
		request := httptest.NewRequest(http.MethodOptions, endpoint.probePath, nil)
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, request)
		if recorder.Code == http.StatusNotFound {
			t.Fatalf("monitored endpoint %s (%s) was not registered on mux", endpoint.description, endpoint.probePath)
		}
	}
}

func TestBuildRequiresProjectID(t *testing.T) {
	_, err := Build(context.Background(), Options{Port: "0"}, Deps{})
	if err == nil {
		t.Fatal("Build should require ProjectID")
	}
}

func TestBuildUsesInjectedFactoriesAndServeShutsDown(t *testing.T) {
	var storageCalls, bqCalls, predictionCalls atomic.Int32
	predictionClosed := atomic.Bool{}

	app, err := Build(context.Background(), Options{
		ProjectID:       "project-1",
		Port:            "0",
		BigQueryDataset: "dataset_1",
	}, Deps{
		NewStorageClient: func(context.Context, string) (*storage.Client, error) {
			storageCalls.Add(1)
			return nil, nil
		},
		NewBigQueryExporter: func(context.Context, string, string, string, string) (*bigqueryexport.Exporter, error) {
			bqCalls.Add(1)
			return nil, nil
		},
		NewPredictionScheduler: func(context.Context, string) (predictionqueue.Scheduler, func() error) {
			predictionCalls.Add(1)
			return predictionqueue.Noop{}, func() error {
				predictionClosed.Store(true)
				return nil
			}
		},
	})
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if storageCalls.Load() != 1 || bqCalls.Load() != 1 || predictionCalls.Load() != 1 {
		t.Fatalf("factory calls storage=%d bq=%d prediction=%d, want 1 each", storageCalls.Load(), bqCalls.Load(), predictionCalls.Load())
	}
	if app == nil || app.Server == nil {
		t.Fatal("Build should return an App with http.Server")
	}
	if app.Server.ReadTimeout <= 0 || app.Server.WriteTimeout <= 0 || app.Server.IdleTimeout <= 0 || app.Server.ReadHeaderTimeout <= 0 {
		t.Fatalf("http.Server timeouts not configured: readHeader=%v read=%v write=%v idle=%v",
			app.Server.ReadHeaderTimeout, app.Server.ReadTimeout, app.Server.WriteTimeout, app.Server.IdleTimeout)
	}

	ctx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() { errCh <- app.Serve(ctx) }()

	var addr string
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		addr = app.Addr()
		if addr != "" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if addr == "" {
		cancel()
		<-errCh
		t.Fatal("server never reported a listen address")
	}

	resp, getErr := http.Get("http://" + addr + "/healthz")
	if getErr != nil {
		cancel()
		<-errCh
		t.Fatalf("healthz: %v", getErr)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		cancel()
		<-errCh
		t.Fatalf("healthz status=%d body=%s", resp.StatusCode, body)
	}

	cancel()
	select {
	case serveErr := <-errCh:
		if serveErr != nil && !errors.Is(serveErr, context.Canceled) {
			t.Fatalf("Serve after cancel: %v", serveErr)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Serve did not return after cancel")
	}

	if !predictionClosed.Load() {
		t.Fatal("prediction closer should run on shutdown")
	}
}

func TestBuildStorageFactoryError(t *testing.T) {
	_, err := Build(context.Background(), Options{ProjectID: "project-1", Port: "0"}, Deps{
		NewStorageClient: func(context.Context, string) (*storage.Client, error) {
			return nil, errors.New("firestore unavailable")
		},
		NewBigQueryExporter: func(context.Context, string, string, string, string) (*bigqueryexport.Exporter, error) {
			return nil, nil
		},
		NewPredictionScheduler: func(context.Context, string) (predictionqueue.Scheduler, func() error) {
			return predictionqueue.Noop{}, nil
		},
	})
	if err == nil {
		t.Fatal("Build should surface storage factory errors")
	}
}
