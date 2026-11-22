package predictor

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRemoteProviderPostsPublicPredictionRequest(t *testing.T) {
	var requestBody map[string]any
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/predict" {
			t.Fatalf("path = %q, want /predict", r.URL.Path)
		}
		if r.Method != http.MethodPost {
			t.Fatalf("method = %q, want POST", r.Method)
		}
		if err := json.NewDecoder(r.Body).Decode(&requestBody); err != nil {
			t.Fatal(err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"checkpoint":{"observation_window_s":60,"status":"ready","risk_level":"low","provider_id":"private-provider","model_version":"opaque-v1","private_detail":"ignored"}}`))
	}))
	defer remote.Close()

	provider, err := NewRemoteProvider(RemoteConfig{URL: remote.URL, Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	checkpoint, err := provider.Predict(context.Background(), RunSnapshot{
		RunID: "run-1",
		Samples: []Sample{
			{ElapsedTime: 60, RSS: 1024, HeapUsed: 50, HeapCap: 100},
		},
		ProcessInfo: map[string]ProcessInfo{
			"123": {PID: "123", Name: "GradleDaemon", VMFlags: []string{"-Xmx2g"}},
		},
		ExistingCheckpoints:   []PredictionCheckpoint{{ObservationWindowS: 30, Status: "ready"}},
		ConfiguredCheckpoints: []int{30, 60, 180},
	}, 60)
	if err != nil {
		t.Fatal(err)
	}

	if checkpoint.Status != "ready" {
		t.Fatalf("checkpoint status = %q, want ready", checkpoint.Status)
	}
	if checkpoint.ProviderID != "private-provider" {
		t.Fatalf("provider id = %q, want private-provider", checkpoint.ProviderID)
	}
	if requestBody["observation_window_s"] != float64(60) {
		t.Fatalf("observation_window_s = %v, want 60", requestBody["observation_window_s"])
	}
	samples, ok := requestBody["samples"].([]any)
	if !ok || len(samples) != 1 {
		t.Fatalf("samples = %#v, want one sample", requestBody["samples"])
	}
	sample, ok := samples[0].(map[string]any)
	if !ok {
		t.Fatalf("sample = %#v, want object", samples[0])
	}
	if _, ok := sample["ElapsedTime"]; ok {
		t.Fatal("request leaked Go field name ElapsedTime")
	}
	if sample["elapsed_time"] != float64(60) {
		t.Fatalf("elapsed_time = %v, want 60", sample["elapsed_time"])
	}
	if _, ok := requestBody["private_detail"]; ok {
		t.Fatal("request should not include private_detail")
	}
}

func TestRemoteProviderReturnsStatusError(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "nope", http.StatusTeapot)
	}))
	defer remote.Close()

	provider, err := NewRemoteProvider(RemoteConfig{URL: remote.URL})
	if err != nil {
		t.Fatal(err)
	}
	_, err = provider.Predict(context.Background(), RunSnapshot{}, 30)
	if err == nil || !strings.Contains(err.Error(), "status 418") {
		t.Fatalf("error = %v, want status 418", err)
	}
	if !errors.Is(err, ErrRemoteFailed) {
		t.Fatalf("error = %v, want remote failed sentinel", err)
	}
}

func TestRemoteProviderClassifiesTransportFailures(t *testing.T) {
	tests := []struct {
		name       string
		statusCode int
		want       error
	}{
		{name: "no data", statusCode: http.StatusNotFound, want: ErrRemoteNoData},
		{name: "timeout", statusCode: http.StatusGatewayTimeout, want: ErrRemoteTimeout},
		{name: "model unavailable", statusCode: http.StatusServiceUnavailable, want: ErrRemoteUnavailable},
		{name: "provider error", statusCode: http.StatusInternalServerError, want: ErrRemoteFailed},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				http.Error(w, "nope", tt.statusCode)
			}))
			defer remote.Close()

			provider, err := NewRemoteProvider(RemoteConfig{URL: remote.URL})
			if err != nil {
				t.Fatal(err)
			}
			_, err = provider.Predict(context.Background(), RunSnapshot{}, 30)
			if err == nil {
				t.Fatal("expected non-2xx status to return error")
			}
			if !errors.Is(err, tt.want) {
				t.Fatalf("error = %v, want sentinel %v", err, tt.want)
			}
		})
	}
}

func TestRemoteProviderRequiresURL(t *testing.T) {
	if _, err := NewRemoteProvider(RemoteConfig{}); err == nil {
		t.Fatal("expected error for missing URL")
	}
}

func TestRemoteProviderDefaultsMissingObservationWindow(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"checkpoint":{"status":"ready"}}`))
	}))
	defer remote.Close()

	provider, err := NewRemoteProvider(RemoteConfig{URL: remote.URL})
	if err != nil {
		t.Fatal(err)
	}
	checkpoint, err := provider.Predict(context.Background(), RunSnapshot{}, 180)
	if err != nil {
		t.Fatal(err)
	}
	if checkpoint.ObservationWindowS != 180 {
		t.Fatalf("observation window = %d, want 180", checkpoint.ObservationWindowS)
	}
}

func TestRemoteForecastProvidersUseModePath(t *testing.T) {
	tests := []struct {
		name     string
		wantPath string
		new      func(RemoteForecastConfig) (*RemoteForecastProvider, error)
	}{
		{name: "forecast", wantPath: "/forecast", new: NewRemoteForecastProvider},
		{name: "tab predict", wantPath: "/tabpredict", new: NewRemoteTabPredictProvider},
		{name: "BQML boosted", wantPath: "/bqml-boosted", new: NewRemoteBQMLBoostedProvider},
		{name: "TabPFN", wantPath: "/tabpfn", new: NewRemoteTabPFNProvider},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var gotPath string
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotPath = r.URL.Path
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"forecasts":[{"process_name":"GradleDaemon","pid":"1","metric":"rss","created_at_ms":1000,"points":[{"target_at_ms":2000,"value_mb":10}]}]}`))
			}))
			defer remote.Close()

			provider, err := tt.new(RemoteForecastConfig{URL: remote.URL + "/predict"})
			if err != nil {
				t.Fatal(err)
			}
			forecasts, err := provider.Forecast(context.Background(), RunSnapshot{RunID: "run-1", Samples: []Sample{{ElapsedTime: 20}}})
			if err != nil {
				t.Fatal(err)
			}
			if gotPath != tt.wantPath {
				t.Fatalf("path = %q, want %q", gotPath, tt.wantPath)
			}
			if len(forecasts) != 1 || forecasts[0].ProcessName != "GradleDaemon" || len(forecasts[0].Points) != 1 {
				t.Fatalf("forecasts=%#v", forecasts)
			}
			if forecasts[0].LatencyMs <= 0 {
				t.Fatalf("latency_ms = %d, want > 0", forecasts[0].LatencyMs)
			}
		})
	}
}

func TestStampForecastLatencyMarksFallback(t *testing.T) {
	forecasts := []ProcessForecast{
		{Method: "ai_forecast", ProviderLatencyMs: 50, InferenceLatencyMs: 40},
		{Method: "last_value"},
	}
	stampForecastLatency(forecasts, 120)
	if forecasts[0].LatencyMs != 120 || forecasts[0].Fallback {
		t.Fatalf("primary = %+v", forecasts[0])
	}
	if forecasts[0].ProviderLatencyMs != 50 || forecasts[0].InferenceLatencyMs != 40 {
		t.Fatalf("provider fields overwritten: %+v", forecasts[0])
	}
	if forecasts[1].LatencyMs != 120 || !forecasts[1].Fallback {
		t.Fatalf("fallback = %+v", forecasts[1])
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

func TestRemoteForecastClassifiesStatus(t *testing.T) {
	cases := []struct {
		name       string
		statusCode int
		want       error
	}{
		{name: "no data", statusCode: http.StatusNotFound, want: ErrRemoteNoData},
		{name: "timeout", statusCode: http.StatusGatewayTimeout, want: ErrRemoteTimeout},
		{name: "unavailable", statusCode: http.StatusServiceUnavailable, want: ErrRemoteUnavailable},
		{name: "failed", statusCode: http.StatusInternalServerError, want: ErrRemoteFailed},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.statusCode)
			}))
			defer remote.Close()
			provider, err := NewRemoteForecastProvider(RemoteForecastConfig{URL: remote.URL})
			if err != nil {
				t.Fatal(err)
			}
			_, err = provider.Forecast(context.Background(), RunSnapshot{RunID: "run-1"})
			if !errors.Is(err, tc.want) {
				t.Fatalf("err=%v, want %v", err, tc.want)
			}
		})
	}
}

func TestNormalizeTimelineBaseURLStripsPredictSuffix(t *testing.T) {
	if got := normalizeTimelineBaseURL("https://provider.example/predict"); got != "https://provider.example" {
		t.Fatalf("got %q", got)
	}
	provider, err := NewRemoteTabPredictProvider(RemoteForecastConfig{
		URL:        "https://provider.example/predict",
		HTTPClient: http.DefaultClient,
	})
	if err != nil {
		t.Fatal(err)
	}
	if provider.client.url != "https://provider.example/tabpredict" {
		t.Fatalf("url = %q, want .../tabpredict", provider.client.url)
	}
}
