package predictor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"time"
)

const defaultRemoteTimeout = 1500 * time.Millisecond

// Remote transport failure kinds. Composition roots map these onto public-safe
// fallback taxonomy; the HTTP adapter does not own scoring sentinel imports.
var (
	ErrRemoteTimeout     = errors.New("remote prediction timeout")
	ErrRemoteNoData      = errors.New("remote prediction no data")
	ErrRemoteUnavailable = errors.New("remote prediction unavailable")
	ErrRemoteFailed      = errors.New("remote prediction failed")
)

// RemoteConfig configures the public-safe remote prediction provider.
type RemoteConfig struct {
	URL          string
	Timeout      time.Duration
	AuthAudience string
	HTTPClient   *http.Client
}

// RemoteProvider calls a private provider over HTTP using only public telemetry.
type RemoteProvider struct {
	client *remoteClient
}

// NewRemoteProvider creates a provider for a private /predict endpoint.
func NewRemoteProvider(config RemoteConfig) (*RemoteProvider, error) {
	endpoint, err := buildPredictURL(config.URL)
	if err != nil {
		return nil, err
	}
	timeout := config.Timeout
	if timeout <= 0 {
		timeout = defaultRemoteTimeout
	}
	client, err := newRemoteClient(endpoint, timeout, config.AuthAudience, config.HTTPClient)
	if err != nil {
		return nil, err
	}
	return &RemoteProvider{client: client}, nil
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
	data, err := p.client.postJSON(ctx, payload)
	if err != nil {
		return PredictionCheckpoint{}, err
	}

	var response remotePredictResponse
	if err := json.Unmarshal(data, &response); err != nil {
		return PredictionCheckpoint{}, newRemoteError(ErrRemoteFailed, fmt.Sprintf("decode prediction response: %v", err), err)
	}
	if response.Checkpoint.ObservationWindowS == 0 {
		response.Checkpoint.ObservationWindowS = observationWindowS
	}
	return response.Checkpoint, nil
}

type remoteError struct {
	kind    error
	message string
	cause   error
}

func newRemoteError(kind error, message string, cause error) error {
	return remoteError{kind: kind, message: message, cause: cause}
}

func (e remoteError) Error() string {
	return e.message
}

func (e remoteError) Unwrap() []error {
	if e.cause == nil {
		return []error{e.kind}
	}
	return []error{e.kind, e.cause}
}

func classifyRemoteStatus(statusCode int) error {
	switch statusCode {
	case http.StatusNotFound:
		return ErrRemoteNoData
	case http.StatusRequestTimeout, http.StatusGatewayTimeout:
		return ErrRemoteTimeout
	case http.StatusServiceUnavailable:
		return ErrRemoteUnavailable
	default:
		return ErrRemoteFailed
	}
}

func isTimeoutError(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
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
