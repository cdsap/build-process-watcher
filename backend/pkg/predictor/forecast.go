package predictor

import (
	"context"
	"net/http"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/models"
)

const defaultForecastTimeout = 20 * time.Second

// ForecastProvider returns public-safe process memory forecasts.
type ForecastProvider interface {
	Forecast(ctx context.Context, snapshot RunSnapshot) ([]models.ProcessForecast, error)
}

// NoopForecastProvider never produces forecasts.
type NoopForecastProvider struct{}

// Forecast returns no issuances.
func (NoopForecastProvider) Forecast(context.Context, RunSnapshot) ([]models.ProcessForecast, error) {
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
	// Path defaults to /forecast. Use /tabpredict or /bqml-boosted for other timeline modes.
	Path string
}

// RemoteForecastProvider calls a private timeline endpoint (/forecast, /tabpredict, /bqml-boosted).
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
	Forecasts []models.ProcessForecast `json:"forecasts"`
}

// Forecast requests process forecasts from the private provider.
func (p *RemoteForecastProvider) Forecast(ctx context.Context, snapshot RunSnapshot) ([]models.ProcessForecast, error) {
	payload := remoteForecastRequest{
		RunID:   snapshot.RunID,
		Samples: toRemoteSamples(snapshot.Samples),
	}
	var response remoteForecastResponse
	if err := p.client.postJSON(ctx, payload, &response); err != nil {
		return nil, err
	}
	return response.Forecasts, nil
}
