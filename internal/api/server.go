package api

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"

	"github.com/cdsap/build-process-watcher-predictive-provider/internal/provider"
	"github.com/cdsap/build-process-watcher-predictive-provider/internal/telemetry"
	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
)

// Server exposes the private prediction provider over a public-safe HTTP API.
type Server struct {
	provider  predictor.Provider
	telemetry *telemetry.Store
	now       func() time.Time
}

type telemetrySource interface {
	Telemetry() *telemetry.Store
}

// NewServer creates an HTTP API server for a private prediction provider.
func NewServer(p predictor.Provider) *Server {
	store := telemetry.NewStore()
	if source, ok := p.(telemetrySource); ok {
		if shared := source.Telemetry(); shared != nil {
			store = shared
		}
	}
	return &Server{
		provider:  p,
		telemetry: store,
		now:       time.Now,
	}
}

// Handler returns all routes exposed by the private provider service.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.health)
	mux.HandleFunc("/predict", s.predict)
	return mux
}

// Telemetry returns the private diagnostics store used for fallback triage.
func (s *Server) Telemetry() *telemetry.Store {
	return s.telemetry
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"status":  "healthy",
		"service": "build-process-watcher-predictive-provider",
	})
}

func (s *Server) predict(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	defer r.Body.Close()

	var req PredictRequest
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		http.Error(w, "invalid prediction request", http.StatusBadRequest)
		return
	}
	if req.ObservationWindowS <= 0 {
		http.Error(w, "observation_window_s is required", http.StatusBadRequest)
		return
	}

	checkpoint, err := s.provider.Predict(r.Context(), req.toSnapshot(s.now()), req.ObservationWindowS)
	if err != nil {
		state, diagnostic := classifyFallback(err)
		s.recordFallback(req.ObservationWindowS, req.RunID, state, diagnostic)
		writeJSON(w, http.StatusOK, PredictResponse{Checkpoint: skippedCheckpoint(req.ObservationWindowS, s.now())})
		return
	}

	writeJSON(w, http.StatusOK, PredictResponse{Checkpoint: checkpoint})
}

func classifyFallback(err error) (telemetry.State, string) {
	switch {
	case errors.Is(err, provider.ErrNoData):
		return telemetry.StateNoData, "fallback after no-data scoring path"
	case errors.Is(err, provider.ErrScoringTimeout), errors.Is(err, provider.ErrModelUnavailable):
		return telemetry.StateModelUnavailable, "fallback after model-unavailable scoring path"
	case errors.Is(err, provider.ErrScoringFailed):
		return telemetry.StateProviderError, "fallback after provider-error scoring path"
	default:
		// Keep private upstream detail in the diagnostic; public response stays generic.
		return telemetry.StateProviderError, "fallback after provider failure: " + err.Error()
	}
}

const apiFallbackModelVersion = "api-fallback"

func (s *Server) recordFallback(observationWindowS int, runID string, state telemetry.State, diagnostic string) {
	event := telemetry.Event{
		ObservationWindowS: observationWindowS,
		ModelVersion:       apiFallbackModelVersion,
		Outcome:            telemetry.OutcomeFallback,
		State:              state,
		Diagnostic:         diagnostic,
		RunID:              runID,
	}
	s.telemetry.Record(event)
	log.Printf(
		"scoring_telemetry outcome=%s state=%s window=%ds model=%q latency_ms=%d run=%q diagnostic=%q",
		event.Outcome,
		event.State,
		event.ObservationWindowS,
		event.ModelVersion,
		event.Latency.Milliseconds(),
		event.RunID,
		event.Diagnostic,
	)
}

func skippedCheckpoint(observationWindowS int, now time.Time) predictor.PredictionCheckpoint {
	return predictor.PredictionCheckpoint{
		ObservationWindowS: observationWindowS,
		Status:             "skipped",
		CreatedAt:          now,
		Message:            "prediction provider unavailable",
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		log.Printf("response encode failed: %v", err)
	}
}

// PredictRequest is the stable wire contract consumed by the public backend.
type PredictRequest struct {
	ObservationWindowS  int                              `json:"observation_window_s"`
	RunID               string                           `json:"run_id"`
	Samples             []Sample                         `json:"samples"`
	ProcessInfo         map[string]predictor.ProcessInfo `json:"process_info,omitempty"`
	ExistingCheckpoints []predictor.PredictionCheckpoint `json:"existing_checkpoints,omitempty"`
	ConfiguredWindows   []int                            `json:"configured_windows,omitempty"`
}

func (r PredictRequest) toSnapshot(now time.Time) predictor.RunSnapshot {
	samples := make([]predictor.Sample, 0, len(r.Samples))
	for _, sample := range r.Samples {
		samples = append(samples, sample.toPredictorSample(r.RunID))
	}
	return predictor.RunSnapshot{
		RunID:                 r.RunID,
		Samples:               samples,
		ProcessInfo:           r.ProcessInfo,
		ExistingCheckpoints:   r.ExistingCheckpoints,
		ConfiguredCheckpoints: r.ConfiguredWindows,
		Now:                   now,
	}
}

// Sample mirrors public run telemetry using JSON names instead of Go field names.
type Sample struct {
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

func (s Sample) toPredictorSample(defaultRunID string) predictor.Sample {
	runID := s.RunID
	if runID == "" {
		runID = defaultRunID
	}
	return predictor.Sample{
		Timestamp:                  s.Timestamp,
		ElapsedTime:                s.ElapsedTime,
		PID:                        s.PID,
		Name:                       s.Name,
		HeapUsed:                   s.HeapUsed,
		HeapCap:                    s.HeapCap,
		RSS:                        s.RSS,
		GCTime:                     s.GCTime,
		JITCompiledMethods:         s.JITCompiledMethods,
		JITFailedCompilations:      s.JITFailedCompilations,
		JITInvalidatedCompilations: s.JITInvalidatedCompilations,
		JITCompilationTimeMs:       s.JITCompilationTimeMs,
		ClassesLoaded:              s.ClassesLoaded,
		ClassesUnloaded:            s.ClassesUnloaded,
		ClassLoadTimeMs:            s.ClassLoadTimeMs,
		RunID:                      runID,
	}
}

// PredictResponse contains only the public-safe checkpoint result.
type PredictResponse struct {
	Checkpoint predictor.PredictionCheckpoint `json:"checkpoint"`
}
