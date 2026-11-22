package predictor

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRemoteActivityPreservesCountContractAndRejectsInvalidResults(t *testing.T) {
	count := 200
	origin := 200.0
	snapshot := RunSnapshot{RunID: "r", Samples: []Sample{{Name: "GradleDaemon", PID: "1", Timestamp: 100000, ClassesLoaded: &count}}}
	for _, kind := range []string{"ready", "unavailable", "wrong total", "wrong horizon", "fallback disguised"} {
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
