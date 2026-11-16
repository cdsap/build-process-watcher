package predictor

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestClassifyRemoteStatus(t *testing.T) {
	tests := []struct {
		name       string
		statusCode int
		want       error
	}{
		{name: "not found", statusCode: http.StatusNotFound, want: ErrRemoteNoData},
		{name: "request timeout", statusCode: http.StatusRequestTimeout, want: ErrRemoteTimeout},
		{name: "gateway timeout", statusCode: http.StatusGatewayTimeout, want: ErrRemoteTimeout},
		{name: "unavailable", statusCode: http.StatusServiceUnavailable, want: ErrRemoteUnavailable},
		{name: "bad request", statusCode: http.StatusBadRequest, want: ErrRemoteFailed},
		{name: "internal error", statusCode: http.StatusInternalServerError, want: ErrRemoteFailed},
		{name: "teapot", statusCode: http.StatusTeapot, want: ErrRemoteFailed},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := classifyRemoteStatus(tt.statusCode)
			if !errors.Is(got, tt.want) {
				t.Fatalf("classifyRemoteStatus(%d) = %v, want %v", tt.statusCode, got, tt.want)
			}
		})
	}
}

func TestBuildPredictURL(t *testing.T) {
	got, err := buildPredictURL(" https://example.test/v1/ ")
	if err != nil {
		t.Fatal(err)
	}
	if got != "https://example.test/v1/predict" {
		t.Fatalf("buildPredictURL = %q, want https://example.test/v1/predict", got)
	}
	if _, err := buildPredictURL("   "); err == nil {
		t.Fatal("expected error for empty URL")
	}
}

func TestBuildTimelineURLNormalizesPathAndStripsPredict(t *testing.T) {
	tests := []struct {
		name        string
		providerURL string
		path        string
		defaultPath string
		want        string
	}{
		{
			name:        "forecast default path",
			providerURL: "https://example.test/api",
			defaultPath: "/forecast",
			want:        "https://example.test/api/forecast",
		},
		{
			name:        "tabpredict strips predict suffix",
			providerURL: "https://example.test/api/predict",
			defaultPath: "/tabpredict",
			want:         "https://example.test/api/tabpredict",
		},
		{
			name:        "tabpredict strips predict with trailing slash",
			providerURL: "https://example.test/api/predict/",
			defaultPath: "/tabpredict",
			want:         "https://example.test/api/tabpredict",
		},
		{
			name:        "bqml-boosted strips predict suffix",
			providerURL: "https://example.test/predict",
			defaultPath: "/bqml-boosted",
			want:         "https://example.test/bqml-boosted",
		},
		{
			name:        "explicit path overrides default",
			providerURL: "https://example.test/api/predict",
			path:        "custom",
			defaultPath: "/tabpredict",
			want:         "https://example.test/api/custom",
		},
		{
			name:        "forecast does not strip unrelated suffix",
			providerURL: "https://example.test/api/prediction",
			defaultPath: "/forecast",
			want:         "https://example.test/api/prediction/forecast",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := buildTimelineURL(tt.providerURL, tt.path, tt.defaultPath)
			if err != nil {
				t.Fatal(err)
			}
			if got != tt.want {
				t.Fatalf("buildTimelineURL = %q, want %q", got, tt.want)
			}
		})
	}
	if _, err := buildTimelineURL("", "", "/forecast"); err == nil {
		t.Fatal("expected error for empty URL")
	}
}

func TestRemoteForecastProviderClassifiesStatusErrors(t *testing.T) {
	tests := []struct {
		name       string
		statusCode int
		want       error
	}{
		{name: "no data", statusCode: http.StatusNotFound, want: ErrRemoteNoData},
		{name: "timeout", statusCode: http.StatusGatewayTimeout, want: ErrRemoteTimeout},
		{name: "unavailable", statusCode: http.StatusServiceUnavailable, want: ErrRemoteUnavailable},
		{name: "failed", statusCode: http.StatusInternalServerError, want: ErrRemoteFailed},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/tabpredict" {
					t.Fatalf("path = %q, want /tabpredict", r.URL.Path)
				}
				http.Error(w, "nope", tt.statusCode)
			}))
			defer remote.Close()

			provider, err := NewRemoteTabPredictProvider(RemoteForecastConfig{
				URL:     remote.URL + "/predict",
				Timeout: time.Second,
			})
			if err != nil {
				t.Fatal(err)
			}
			_, err = provider.Forecast(context.Background(), RunSnapshot{RunID: "run-1"})
			if err == nil {
				t.Fatal("expected non-2xx status to return error")
			}
			if !errors.Is(err, tt.want) {
				t.Fatalf("error = %v, want sentinel %v", err, tt.want)
			}
		})
	}
}

func TestRemoteTabPredictProviderStripsPredictSuffix(t *testing.T) {
	var gotPath string
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(remoteForecastResponse{})
	}))
	defer remote.Close()

	provider, err := NewRemoteTabPredictProvider(RemoteForecastConfig{
		URL:     remote.URL + "/predict",
		Timeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.Forecast(context.Background(), RunSnapshot{RunID: "run-1"}); err != nil {
		t.Fatal(err)
	}
	if gotPath != "/tabpredict" {
		t.Fatalf("path = %q, want /tabpredict", gotPath)
	}
}
