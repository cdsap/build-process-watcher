package predictor

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRemoteForecastProvidersUseModePath(t *testing.T) {
	tests := []struct {
		name     string
		wantPath string
		new      func(RemoteForecastConfig) (*RemoteForecastProvider, error)
	}{
		{name: "forecast", wantPath: "/forecast", new: NewRemoteForecastProvider},
		{name: "tab predict", wantPath: "/tabpredict", new: NewRemoteTabPredictProvider},
		{name: "BQML boosted", wantPath: "/bqml-boosted", new: NewRemoteBQMLBoostedProvider},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var gotPath string
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotPath = r.URL.Path
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"forecasts":[{"process_name":"GradleDaemon","metric":"rss","created_at_ms":20000}]}`))
			}))
			defer remote.Close()

			provider, err := tt.new(RemoteForecastConfig{URL: remote.URL + "/predict"})
			if err != nil {
				t.Fatal(err)
			}
			forecasts, err := provider.Forecast(context.Background(), RunSnapshot{RunID: "run-1"})
			if err != nil {
				t.Fatal(err)
			}
			if gotPath != tt.wantPath {
				t.Fatalf("path = %q, want %q", gotPath, tt.wantPath)
			}
			if len(forecasts) != 1 || forecasts[0].ProcessName != "GradleDaemon" {
				t.Fatalf("forecasts = %#v, want one GradleDaemon forecast", forecasts)
			}
		})
	}
}

func TestRemoteForecastProviderUsesConfiguredPath(t *testing.T) {
	var gotPath string
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_, _ = w.Write([]byte(`{"forecasts":[]}`))
	}))
	defer remote.Close()

	provider, err := NewRemoteForecastProvider(RemoteForecastConfig{URL: remote.URL, Path: "custom-forecast"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.Forecast(context.Background(), RunSnapshot{}); err != nil {
		t.Fatal(err)
	}
	if gotPath != "/custom-forecast" {
		t.Fatalf("path = %q, want /custom-forecast", gotPath)
	}
}

func TestRemoteForecastProviderReturnsStatusError(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
	}))
	defer remote.Close()

	provider, err := NewRemoteForecastProvider(RemoteForecastConfig{URL: remote.URL})
	if err != nil {
		t.Fatal(err)
	}
	_, err = provider.Forecast(context.Background(), RunSnapshot{})
	if err == nil || !strings.Contains(err.Error(), "status 503") {
		t.Fatalf("error = %v, want status 503", err)
	}
}
