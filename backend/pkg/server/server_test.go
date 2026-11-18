package server

import (
	"context"
	"errors"
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
