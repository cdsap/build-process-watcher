package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/cdsap/build-process-watcher/backend/internal/auth"
	"github.com/cdsap/build-process-watcher/backend/internal/storage"
	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
)

func providerEnv(suffix string) string {
	return "PREDICTIVE_PROVIDER_" + suffix
}

func TestOptionsFromEnvDefaultsTimelineProvidersToNoop(t *testing.T) {
	t.Setenv("GOOGLE_CLOUD_PROJECT", "test-project")
	t.Setenv("PORT", "9090")
	t.Setenv(providerEnv("ENABLED"), "false")
	t.Setenv("PREDICTIVE_FORECAST_PROVIDER_ENABLED", "")
	t.Setenv("PREDICTIVE_TABPREDICT_PROVIDER_ENABLED", "")
	t.Setenv("PREDICTIVE_BQML_BOOSTED_PROVIDER_ENABLED", "")
	t.Setenv("PREDICTIVE_TABPFN_PROVIDER_ENABLED", "")

	options := OptionsFromEnv()
	if options.ProjectID != "test-project" || options.Port != "9090" {
		t.Fatalf("options = %+v", options)
	}
	if predictor.ForecastEnabled(options.ForecastProvider) ||
		predictor.ForecastEnabled(options.TabPredictProvider) ||
		predictor.ForecastEnabled(options.BQMLBoostedProvider) ||
		predictor.ForecastEnabled(options.TabPFNProvider) {
		t.Fatal("timeline providers should default to noop when disabled")
	}
}

func TestOptionsFromEnvEnablesForecastWhenRequested(t *testing.T) {
	t.Setenv("GOOGLE_CLOUD_PROJECT", "test-project")
	t.Setenv(providerEnv("URL"), "https://provider.example")
	t.Setenv("PREDICTIVE_FORECAST_PROVIDER_ENABLED", "true")
	t.Setenv("PREDICTIVE_TABPREDICT_PROVIDER_ENABLED", "false")
	t.Setenv("PREDICTIVE_BQML_BOOSTED_PROVIDER_ENABLED", "false")
	t.Setenv("PREDICTIVE_TABPFN_PROVIDER_ENABLED", "false")

	options := OptionsFromEnv()
	if !predictor.ForecastEnabled(options.ForecastProvider) {
		t.Fatal("forecast provider should be enabled")
	}
	if predictor.ForecastEnabled(options.TabPredictProvider) ||
		predictor.ForecastEnabled(options.BQMLBoostedProvider) ||
		predictor.ForecastEnabled(options.TabPFNProvider) {
		t.Fatal("other timeline providers should stay noop")
	}
}

func TestBuildUsesInjectedAuthenticatorFactory(t *testing.T) {
	called := false
	_, err := Build(context.Background(), Options{ProjectID: "proj"}, Deps{
		NewAuthenticator: func() (*auth.Authenticator, error) {
			called = true
			return auth.NewForTest("jwt", "admin"), nil
		},
		NewStorage: func(context.Context, string) (*storage.Client, error) {
			return nil, errors.New("stop after auth")
		},
	})
	if !called {
		t.Fatal("NewAuthenticator was not called")
	}
	if err == nil || err.Error() != "stop after auth" {
		t.Fatalf("err=%v, want stop after auth", err)
	}
}

func TestBuildPropagatesAuthenticatorFactoryError(t *testing.T) {
	_, err := Build(context.Background(), Options{ProjectID: "proj"}, Deps{
		NewAuthenticator: func() (*auth.Authenticator, error) {
			return nil, errors.New("auth boom")
		},
	})
	if err == nil || err.Error() != "auth boom" {
		t.Fatalf("err=%v, want auth boom", err)
	}
}

func TestActivityOptionsFollowModeEnablement(t *testing.T) {
	for _, mode := range []string{"disabled", "forecast", "predict", "tabpfn", "bqml-boosted"} {
		t.Run(mode, func(t *testing.T) {
			options, err := buildOptions(serverConfig{predictionProviderURL: "https://provider.example", forecastProviderEnabled: mode == "forecast", tabPredictProviderEnabled: mode == "predict", tabpfnProviderEnabled: mode == "tabpfn", bqmlBoostedProviderEnabled: mode == "bqml-boosted"})
			if err != nil {
				t.Fatal(err)
			}
			if (options.ForecastActivityProvider != nil) != (mode == "forecast") || (options.TabPredictActivityProvider != nil) != (mode == "predict") || (options.ActivityProvider != nil) != (mode == "tabpfn") {
				t.Fatal("activity providers did not follow their mode enablement")
			}
		})
	}
	options, err := buildOptions(serverConfig{forecastProviderEnabled: true, tabPredictProviderEnabled: true, tabpfnProviderEnabled: true})
	if err == nil || options.ForecastActivityProvider != nil || options.TabPredictActivityProvider != nil || options.ActivityProvider != nil {
		t.Fatal("missing provider URL must not enable activity")
	}
}

func TestManagedActivityOptionsValidateProviderMethod(t *testing.T) {
	for _, tc := range []struct {
		mode, path, method string
		ready              bool
	}{
		{"forecast", "/forecast/activity", "ai_forecast", true},
		{"forecast", "/forecast/activity", "timesfm", false},
		{"predict", "/tabpredict/activity", "ai_predict", true},
		{"predict", "/tabpredict/activity", "tabfm", false},
	} {
		t.Run(tc.mode+"/"+tc.method, func(t *testing.T) {
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != tc.path {
					t.Errorf("path=%s want=%s", r.URL.Path, tc.path)
				}
				w.Header().Set("Content-Type", "application/json")
				fmt.Fprintf(w, `{"forecasts":[{"process_name":"GradleDaemon","pid":"1","metric":"classes_loaded","created_at_ms":1000,"origin_value_count":100,"points":[{"target_at_ms":61000,"predicted_delta_count":2,"predicted_total_count":102}],"status":"ready","method":%q,"model_version":"contract-test"}]}`, tc.method)
			}))
			defer remote.Close()
			options, err := buildOptions(serverConfig{predictionProviderURL: remote.URL, forecastProviderEnabled: tc.mode == "forecast", tabPredictProviderEnabled: tc.mode == "predict"})
			if err != nil {
				t.Fatal(err)
			}
			provider := options.ForecastActivityProvider
			if tc.mode == "predict" {
				provider = options.TabPredictActivityProvider
			}
			count := 100
			forecasts, err := provider.ForecastActivity(context.Background(), predictor.RunSnapshot{RunID: "run", Samples: []predictor.Sample{{Timestamp: 1000, Name: "GradleDaemon", PID: "1", ClassesLoaded: &count}}})
			if tc.ready {
				if err != nil || len(forecasts) != 1 || forecasts[0].Status != "ready" {
					t.Fatalf("forecasts=%v err=%v", forecasts, err)
				}
			} else if err == nil {
				t.Fatal("wrong provider method accepted")
			}
		})
	}
}
