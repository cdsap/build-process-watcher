package predictor

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"google.golang.org/api/idtoken"
)

const defaultRemoteTimeout = 1500 * time.Millisecond

// RemoteConfig configures the public-safe remote prediction provider.
type RemoteConfig struct {
	URL          string
	Timeout      time.Duration
	AuthAudience string
	HTTPClient   *http.Client
}

// RemoteProvider calls a private provider over HTTP using only public telemetry.
type RemoteProvider struct {
	url    string
	client *http.Client
}

// NewRemoteProvider creates a provider for a private /predict endpoint.
func NewRemoteProvider(config RemoteConfig) (*RemoteProvider, error) {
	providerURL := strings.TrimSpace(config.URL)
	if providerURL == "" {
		return nil, fmt.Errorf("remote provider url is required")
	}
	timeout := config.Timeout
	if timeout <= 0 {
		timeout = defaultRemoteTimeout
	}
	client := config.HTTPClient
	if client == nil {
		if audience := strings.TrimSpace(config.AuthAudience); audience != "" {
			idTokenClient, err := idtoken.NewClient(context.Background(), audience)
			if err != nil {
				return nil, fmt.Errorf("create identity token client: %w", err)
			}
			idTokenClient.Timeout = timeout
			client = idTokenClient
		} else {
			client = &http.Client{Timeout: timeout}
		}
	}
	return &RemoteProvider{
		url:    strings.TrimRight(providerURL, "/") + "/predict",
		client: client,
	}, nil
}

// Predict requests one public-safe prediction checkpoint from the private provider.
func (p *RemoteProvider) Predict(ctx context.Context, snapshot RunSnapshot, observationWindowS int) (PredictionCheckpoint, error) {
	payload := remotePredictRequest{
		ObservationWindowS:  observationWindowS,
		RunID:               snapshot.RunID,
		Samples:             toRemoteSamples(snapshot.Samples),
		ProcessInfo:         snapshot.ProcessInfo,
		ExistingCheckpoints: snapshot.ExistingCheckpoints,
		ConfiguredWindows:   snapshot.ConfiguredCheckpoints,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return PredictionCheckpoint{}, fmt.Errorf("encode prediction request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, p.url, bytes.NewReader(body))
	if err != nil {
		return PredictionCheckpoint{}, fmt.Errorf("create prediction request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := p.client.Do(req)
	if err != nil {
		return PredictionCheckpoint{}, fmt.Errorf("remote prediction request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return PredictionCheckpoint{}, fmt.Errorf("remote prediction provider returned status %d", resp.StatusCode)
	}

	decoder := json.NewDecoder(resp.Body)
	var response remotePredictResponse
	if err := decoder.Decode(&response); err != nil {
		return PredictionCheckpoint{}, fmt.Errorf("decode prediction response: %w", err)
	}
	if response.Checkpoint.ObservationWindowS == 0 {
		response.Checkpoint.ObservationWindowS = observationWindowS
	}
	return response.Checkpoint, nil
}

type remotePredictRequest struct {
	ObservationWindowS  int                    `json:"observation_window_s"`
	RunID               string                 `json:"run_id"`
	Samples             []remoteSample         `json:"samples"`
	ProcessInfo         map[string]ProcessInfo `json:"process_info,omitempty"`
	ExistingCheckpoints []PredictionCheckpoint `json:"existing_checkpoints,omitempty"`
	ConfiguredWindows   []int                  `json:"configured_windows,omitempty"`
}

type remoteSample struct {
	Timestamp                  int64  `json:"timestamp,omitempty"`
	ElapsedTime                int    `json:"elapsed_time"`
	PID                        string `json:"pid,omitempty"`
	Name                       string `json:"name,omitempty"`
	HeapUsed                   int    `json:"heap_used,omitempty"`
	HeapCap                    int    `json:"heap_cap,omitempty"`
	RSS                        int    `json:"rss,omitempty"`
	GCTime                     int    `json:"gc_time,omitempty"`
	JITCompiledMethods         *int   `json:"jit_compiled_methods,omitempty"`
	JITFailedCompilations      *int   `json:"jit_failed_compilations,omitempty"`
	JITInvalidatedCompilations *int   `json:"jit_invalidated_compilations,omitempty"`
	JITCompilationTimeMs       *int   `json:"jit_compilation_time_ms,omitempty"`
	ClassesLoaded              *int   `json:"classes_loaded,omitempty"`
	ClassesUnloaded            *int   `json:"classes_unloaded,omitempty"`
	ClassLoadTimeMs            *int   `json:"class_load_time_ms,omitempty"`
	RunID                      string `json:"run_id,omitempty"`
}

func toRemoteSamples(samples []Sample) []remoteSample {
	remoteSamples := make([]remoteSample, 0, len(samples))
	for _, sample := range samples {
		remoteSamples = append(remoteSamples, remoteSample{
			Timestamp:                  sample.Timestamp,
			ElapsedTime:                sample.ElapsedTime,
			PID:                        sample.PID,
			Name:                       sample.Name,
			HeapUsed:                   sample.HeapUsed,
			HeapCap:                    sample.HeapCap,
			RSS:                        sample.RSS,
			GCTime:                     sample.GCTime,
			JITCompiledMethods:         sample.JITCompiledMethods,
			JITFailedCompilations:      sample.JITFailedCompilations,
			JITInvalidatedCompilations: sample.JITInvalidatedCompilations,
			JITCompilationTimeMs:       sample.JITCompilationTimeMs,
			ClassesLoaded:              sample.ClassesLoaded,
			ClassesUnloaded:            sample.ClassesUnloaded,
			ClassLoadTimeMs:            sample.ClassLoadTimeMs,
			RunID:                      sample.RunID,
		})
	}
	return remoteSamples
}

type remotePredictResponse struct {
	Checkpoint PredictionCheckpoint `json:"checkpoint"`
}

var _ Provider = (*RemoteProvider)(nil)
