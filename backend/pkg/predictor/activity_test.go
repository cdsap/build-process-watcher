package predictor

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRemoteActivityPreservesCountContractAndRejectsInvalidResults(t *testing.T) {
	count := 200
	origin := 200.0
	snapshot := RunSnapshot{RunID: "r", Samples: []Sample{{Name: "GradleDaemon", PID: "1", Timestamp: 100000, ClassesLoaded: &count}}}
	for _, kind := range []string{"ready", "unavailable", "wrong total", "wrong horizon", "wrong method", "fallback disguised"} {
		t.Run(kind, func(t *testing.T) {
			f := ProcessActivityForecast{ProcessName: "GradleDaemon", PID: "1", Metric: "classes_loaded", CreatedAtMs: 100000, OriginValueCount: &origin, Status: "ready", Method: "tabpfn", ModelVersion: "test", Points: []ActivityForecastPoint{{TargetAtMs: 160000, PredictedDeltaCount: 25, PredictedTotalCount: 225}}}
			switch kind {
			case "unavailable":
				f.Status = "unavailable"
				f.Points = nil
			case "wrong total":
				f.Points[0].PredictedTotalCount = 999
			case "wrong horizon":
				f.Points[0].TargetAtMs = 170000
			case "wrong method":
				f.Method = "timesfm"
			case "fallback disguised":
				f.Fallback = true
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/tabpfn/activity" {
					t.Errorf("path=%s", r.URL.Path)
				}
				var req remoteForecastRequest
				if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.RunID != "r" || req.Samples[0].ClassesLoaded == nil || *req.Samples[0].ClassesLoaded != 200 {
					t.Error("lost counter mapping")
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"forecasts": []ProcessActivityForecast{f}})
			}))
			defer server.Close()
			provider, err := NewRemoteActivityProvider(RemoteForecastConfig{URL: server.URL, HTTPClient: server.Client()})
			if err != nil {
				t.Fatal(err)
			}
			got, err := provider.ForecastActivity(context.Background(), snapshot)
			if kind == "ready" || kind == "unavailable" {
				if err != nil || len(got) != 1 || got[0].Status != kind || got[0].LatencyMs < 1 {
					t.Fatalf("got=%v err=%v", got, err)
				}
			} else if err == nil {
				t.Fatal("malformed count result accepted")
			}
		})
	}
}

func TestActivityProviderSelectionAndValidation(t *testing.T) {
	count := 200
	origin := 200.0
	snapshot := RunSnapshot{RunID: "r", Samples: []Sample{{Name: "GradleDaemon", PID: "1", Timestamp: 100000, ClassesLoaded: &count}}}
	for _, provider := range []struct{ path, method string }{
		{"/forecast/activity", "timesfm"}, {"/tabpredict/activity", "tabfm"}, {"/tabpfn/activity", "tabpfn"},
	} {
		t.Run(provider.method, func(t *testing.T) {
			ready := func() ProcessActivityForecast {
				return ProcessActivityForecast{ProcessName: "GradleDaemon", PID: "1", Metric: "classes_loaded", CreatedAtMs: 100000, OriginValueCount: &origin, Status: "ready", Method: provider.method, ModelVersion: "v1", ProviderLatencyMs: 12, InferenceLatencyMs: 10, Points: []ActivityForecastPoint{{TargetAtMs: 160000, PredictedDeltaCount: 25, PredictedTotalCount: 225}}}
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != provider.path {
					t.Errorf("path=%s want=%s", r.URL.Path, provider.path)
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"forecasts": []ProcessActivityForecast{ready()}})
			}))
			defer server.Close()
			client, err := NewRemoteActivityProvider(RemoteForecastConfig{URL: server.URL + "/predict", HTTPClient: server.Client(), Path: provider.path, ExpectedMethod: provider.method})
			if err != nil {
				t.Fatal(err)
			}
			got, err := client.ForecastActivity(context.Background(), snapshot)
			if err != nil || len(got) != 1 || got[0].Method != provider.method || got[0].ModelVersion != "v1" || got[0].ProviderLatencyMs != 12 || got[0].InferenceLatencyMs != 10 || got[0].Points[0].PredictedTotalCount != 225 {
				t.Fatalf("got=%v err=%v", got, err)
			}
			for _, kind := range []string{"method", "negative delta", "negative total", "nan delta", "infinite delta", "nan total", "infinite total", "origin", "total", "horizon", "model", "fallback"} {
				t.Run(kind, func(t *testing.T) {
					f := ready()
					switch kind {
					case "method":
						f.Method = "another-provider"
					case "negative delta":
						f.Points[0].PredictedDeltaCount = -1
					case "negative total":
						f.Points[0].PredictedTotalCount = -1
					case "nan delta":
						f.Points[0].PredictedDeltaCount = math.NaN()
					case "infinite delta":
						f.Points[0].PredictedDeltaCount = math.Inf(1)
					case "nan total":
						f.Points[0].PredictedTotalCount = math.NaN()
					case "infinite total":
						f.Points[0].PredictedTotalCount = math.Inf(1)
					case "origin":
						v := 201.0
						f.OriginValueCount = &v
					case "total":
						f.Points[0].PredictedTotalCount = 226
					case "horizon":
						f.Points[0].TargetAtMs++
					case "model":
						f.ModelVersion = ""
					case "fallback":
						f.Fallback = true
					}
					if err := validateActivity(f, snapshot, provider.method); err == nil {
						t.Fatal("invalid ready response accepted")
					}
				})
			}
			for _, status := range []string{"insufficient_history", "unavailable", "fallback"} {
				f := ready()
				f.Status = status
				if status == "fallback" {
					f.Fallback = true
					f.Method = "recent-rate"
				} else {
					f.Points = nil
					f.OriginValueCount = nil
				}
				if err := validateActivity(f, snapshot, provider.method); err != nil {
					t.Fatalf("status=%s: %v", status, err)
				}
			}
		})
	}
}
