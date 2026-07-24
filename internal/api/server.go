package api

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
)

// Server exposes the private prediction provider over a public-safe HTTP API.
type Server struct {
	provider predictor.Provider
	now      func() time.Time
}

// NewServer creates an HTTP API server for a private prediction provider.
func NewServer(provider predictor.Provider) *Server {
	return &Server{
		provider: provider,
		now:      time.Now,
	}
}

// Handler returns all routes exposed by the private provider service.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.health)
	mux.HandleFunc("/predict", s.predict)
	return mux
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
		log.Printf("prediction failed for run %q checkpoint %ds: %v", req.RunID, req.ObservationWindowS, err)
		http.Error(w, "prediction failed", http.StatusUnprocessableEntity)
		return
	}

	writeJSON(w, http.StatusOK, PredictResponse{Checkpoint: checkpoint})
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
