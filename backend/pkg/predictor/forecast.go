package predictor

import (
	"context"
	"net/http"
	"time"
)

const defaultForecastTimeout = 20 * time.Second

// ForecastProvider returns public-safe process memory forecasts.
type ForecastProvider interface {
	Forecast(ctx context.Context, snapshot RunSnapshot) ([]ProcessForecast, error)
}

// NoopForecastProvider never produces forecasts.
type NoopForecastProvider struct{}

// Forecast returns no issuances.
func (NoopForecastProvider) Forecast(context.Context, RunSnapshot) ([]ProcessForecast, error) {
	return nil, nil
}

// ForecastEnabled reports whether a forecast provider is configured beyond noop.
func ForecastEnabled(provider ForecastProvider) bool {
	if provider == nil {
		return false
	}
	_, ok := provider.(NoopForecastProvider)
	return !ok
}

// RemoteForecastConfig configures the private timeline forecast client.
type RemoteForecastConfig struct {
	URL          string
	Timeout      time.Duration
	AuthAudience string
	HTTPClient   *http.Client
	// Path defaults to /forecast. Use /tabpredict, /bqml-boosted, or /tabpfn for other timeline modes.
	Path string
	// ExpectedMethod validates ready activity responses; defaults to tabpfn.
	// Memory forecast responses retain their existing contract.
	ExpectedMethod string
}

// RemoteForecastProvider calls a private timeline endpoint (/forecast, /tabpredict, /bqml-boosted, /tabpfn).
type RemoteForecastProvider struct {
	client *remoteClient
}

// NewRemoteForecastProvider creates a client for the private forecast endpoint.
func NewRemoteForecastProvider(config RemoteForecastConfig) (*RemoteForecastProvider, error) {
	return newRemoteTimelineProvider(config, "/forecast")
}

// NewRemoteTabPredictProvider creates a client for the private TabFM endpoint.
func NewRemoteTabPredictProvider(config RemoteForecastConfig) (*RemoteForecastProvider, error) {
	return newRemoteTimelineProvider(config, "/tabpredict")
}

// NewRemoteBQMLBoostedProvider creates a client for the private BQML boosted endpoint.
func NewRemoteBQMLBoostedProvider(config RemoteForecastConfig) (*RemoteForecastProvider, error) {
	return newRemoteTimelineProvider(config, "/bqml-boosted")
}

// NewRemoteTabPFNProvider creates a client for the private TabPFN GPU endpoint.
func NewRemoteTabPFNProvider(config RemoteForecastConfig) (*RemoteForecastProvider, error) {
	return newRemoteTimelineProvider(config, "/tabpfn")
}

func newRemoteTimelineProvider(config RemoteForecastConfig, defaultPath string) (*RemoteForecastProvider, error) {
	client, err := newRemoteClient(remoteHTTPConfig{
		URL:                config.URL,
		Timeout:            config.Timeout,
		AuthAudience:       config.AuthAudience,
		HTTPClient:         config.HTTPClient,
		DefaultPath:        defaultPath,
		Path:               config.Path,
		StripPredictSuffix: true,
	}, defaultForecastTimeout)
	if err != nil {
		return nil, err
	}
	return &RemoteForecastProvider{client: client}, nil
}

type remoteForecastRequest struct {
	RunID   string         `json:"run_id"`
	Samples []remoteSample `json:"samples"`
}

type remoteForecastResponse struct {
	Forecasts []ProcessForecast `json:"forecasts"`
}

// Forecast requests process forecasts from the private provider.
func (p *RemoteForecastProvider) Forecast(ctx context.Context, snapshot RunSnapshot) ([]ProcessForecast, error) {
	payload := remoteForecastRequest{
		RunID:   snapshot.RunID,
		Samples: toRemoteSamples(snapshot.Samples),
	}
	var response remoteForecastResponse
	started := time.Now()
	if err := p.client.postJSON(ctx, payload, &response); err != nil {
		return nil, err
	}
	latencyMs := time.Since(started).Milliseconds()
	if latencyMs <= 0 {
		latencyMs = 1
	}
	stampForecastLatency(response.Forecasts, latencyMs)
	return response.Forecasts, nil
}

// stampForecastLatency writes end-to-end public→private latency onto issuances.
// Provider/inference timings from the private response are preserved when present.
func stampForecastLatency(forecasts []ProcessForecast, latencyMs int64) {
	if latencyMs <= 0 || len(forecasts) == 0 {
		return
	}
	for i := range forecasts {
		forecasts[i].LatencyMs = latencyMs
		if forecasts[i].Method == "last_value" {
			forecasts[i].Fallback = true
		}
	}
}
