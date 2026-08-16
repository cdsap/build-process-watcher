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

	"github.com/cdsap/build-process-watcher/backend/internal/scoring"
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
	if !errors.Is(err, scoring.ErrScoringFailed) {
		t.Fatalf("error = %v, want scoring failed sentinel", err)
	}
}

func TestRemoteProviderClassifiesSharedScoringErrors(t *testing.T) {
	tests := []struct {
		name       string
		statusCode int
		want       error
	}{
		{name: "no data", statusCode: http.StatusNotFound, want: scoring.ErrNoData},
		{name: "timeout", statusCode: http.StatusGatewayTimeout, want: scoring.ErrScoringTimeout},
		{name: "model unavailable", statusCode: http.StatusServiceUnavailable, want: scoring.ErrModelUnavailable},
		{name: "provider error", statusCode: http.StatusInternalServerError, want: scoring.ErrScoringFailed},
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
