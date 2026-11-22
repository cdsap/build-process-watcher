package predictor

import (
	"context"
	"fmt"
	"math"
	"time"
)

type ActivityProvider interface {
	ForecastActivity(context.Context, RunSnapshot) ([]ProcessActivityForecast, error)
}
type RemoteActivityProvider struct{ client *remoteClient }

func NewRemoteActivityProvider(config RemoteForecastConfig) (*RemoteActivityProvider, error) {
	client, err := newRemoteClient(remoteHTTPConfig{URL: config.URL, Timeout: config.Timeout, AuthAudience: config.AuthAudience, HTTPClient: config.HTTPClient, DefaultPath: "/tabpfn/activity", StripPredictSuffix: true}, defaultForecastTimeout)
	if err != nil {
		return nil, err
	}
	return &RemoteActivityProvider{client}, nil
}
func (p *RemoteActivityProvider) ForecastActivity(ctx context.Context, snapshot RunSnapshot) ([]ProcessActivityForecast, error) {
	var response struct {
		Forecasts []ProcessActivityForecast `json:"forecasts"`
	}
	started := time.Now()
	err := p.client.postJSON(ctx, remoteForecastRequest{RunID: snapshot.RunID, Samples: toRemoteSamples(snapshot.Samples)}, &response)
	if err != nil {
		return nil, err
	}
	for _, f := range response.Forecasts {
		if err := validateActivity(f, snapshot); err != nil {
			return nil, err
		}
	}
	for i := range response.Forecasts {
		response.Forecasts[i].LatencyMs = max(1, time.Since(started).Milliseconds())
	}
	return response.Forecasts, nil
}

func validateActivity(f ProcessActivityForecast, snapshot RunSnapshot) error {
	invalid := func() error { return fmt.Errorf("invalid activity forecast contract") }
	if f.Metric != "classes_loaded" || (f.ProcessName != "GradleDaemon" && f.ProcessName != "KotlinCompileDaemon") || f.CreatedAtMs <= 0 {
		return invalid()
	}
	var origin *Sample
	for i := range snapshot.Samples {
		s := &snapshot.Samples[i]
		if s.PID == f.PID && s.Name == f.ProcessName && s.Timestamp == f.CreatedAtMs {
			origin = s
			break
		}
	}
	if origin == nil {
		return invalid()
	}
	switch f.Status {
	case "insufficient_history", "unavailable":
		if len(f.Points) != 0 {
			return invalid()
		}
		return nil
	case "ready", "fallback":
	default:
		return invalid()
	}
	if origin.ClassesLoaded == nil || f.OriginValueCount == nil || *f.OriginValueCount != float64(*origin.ClassesLoaded) || *f.OriginValueCount < 0 || len(f.Points) != 1 {
		return invalid()
	}
	if f.Status == "ready" && (f.Fallback || f.Method != "tabpfn" || f.ModelVersion == "") {
		return invalid()
	}
	if f.Status == "fallback" && !f.Fallback {
		return invalid()
	}
	point := f.Points[0]
	if point.TargetAtMs != f.CreatedAtMs+60000 || point.PredictedDeltaCount < 0 || math.IsNaN(point.PredictedDeltaCount) || math.IsInf(point.PredictedDeltaCount, 0) || math.IsNaN(point.PredictedTotalCount) || math.IsInf(point.PredictedTotalCount, 0) || math.Abs(point.PredictedTotalCount-(*f.OriginValueCount+point.PredictedDeltaCount)) > 0.000001 {
		return invalid()
	}
	return nil
}
