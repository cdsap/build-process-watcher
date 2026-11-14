package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/auth"
	"github.com/cdsap/build-process-watcher/backend/internal/models"
	"github.com/cdsap/build-process-watcher/backend/internal/prediction"
	"github.com/cdsap/build-process-watcher/backend/internal/predictionqueue"
	"github.com/cdsap/build-process-watcher/backend/internal/storage"
	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
)

// predictionJobTimeout bounds checkpoint/forecast work on the job handler.
// TabFM can take tens of seconds; keep this above the provider client timeout.
const predictionJobTimeout = 45 * time.Second

const predictionJobTokenHeader = "X-BPW-Prediction-Job-Token"

// Handlers contains all HTTP handlers
type Handlers struct {
	storage             Storage
	export              Exporter
	checkpointEvaluator *prediction.CheckpointEvaluator
	forecastEvaluator   *prediction.ForecastEvaluator
	// predictionScheduler enqueues evaluation off the /ingest path (Cloud Tasks).
	predictionScheduler predictionqueue.Scheduler
	// predictionJobToken authorizes POST /internal/prediction-jobs.
	predictionJobToken string
}

// Storage is the persistence port used by the HTTP handlers and checkpoint
// evaluator. The production implementation is storage.Client.
type Storage interface {
	GetRun(runID string) (*models.RunDoc, error)
	GetProcesses(runID string) (*models.ProcessDoc, error)
	StoreSamples(runID string, samples []models.Sample) error
	StoreProcessInfo(runID string, processInfo models.ProcessInfo) error
	StorePredictionCheckpoint(runID string, checkpoint models.PredictionCheckpoint) error
	AppendProcessForecasts(runID string, forecasts []models.ProcessForecast) error
	SetRunExportToBigquery(runID string, enabled bool) error
	SetRunPredictiveReliability(runID string, enabled bool) error
	SetRunPredictionMode(runID, mode string) error
	MarkRunAsFinished(runID string) (bool, error)
}

// Exporter is the export scheduling port used by the HTTP handlers. The
// production implementation is exportqueue.Scheduler.
type Exporter interface {
	Run(runID string)
}

// NewHandlers creates a new handlers instance. export may be nil (no BigQuery jobs).
func NewHandlers(storageClient Storage, export Exporter) *Handlers {
	return NewHandlersWithPredictor(storageClient, export, predictor.NoopProvider{}, nil, nil, predictor.NoopForecastProvider{}, predictor.NoopForecastProvider{})
}

// NewHandlersWithPredictor creates handlers with optional reliability, forecast, and
// tabpredict providers plus an optional fallback classifier supplied by the composition root.
func NewHandlersWithPredictor(storageClient Storage, export Exporter, predictionProvider predictor.Provider, checkpoints []int, fallbackClassifier predictor.FallbackClassifier, forecastProvider predictor.ForecastProvider, tabPredictProvider predictor.ForecastProvider) *Handlers {
	var checkpointRepo prediction.CheckpointRepository
	var forecastRepo prediction.ForecastRepository
	if storageClient != nil {
		checkpointRepo = storageClient
		forecastRepo = storageClient
	}
	return &Handlers{
		storage:             storageClient,
		export:              export,
		checkpointEvaluator: prediction.NewCheckpointEvaluator(checkpointRepo, predictionProvider, checkpoints, fallbackClassifier),
		forecastEvaluator:   prediction.NewForecastEvaluatorWithTabPredict(forecastRepo, forecastProvider, tabPredictProvider),
		predictionScheduler: predictionqueue.Noop{},
	}
}

// SetPredictionScheduler installs the off-ingest prediction job scheduler.
func (h *Handlers) SetPredictionScheduler(scheduler predictionqueue.Scheduler, jobToken string) {
	if h == nil {
		return
	}
	if scheduler == nil {
		scheduler = predictionqueue.Noop{}
	}
	h.predictionScheduler = scheduler
	h.predictionJobToken = strings.TrimSpace(jobToken)
}

// runPredictionEvaluation runs reliability checkpoints and process forecasts.
// Invoked only from the prediction job handler — never from /ingest.
func (h *Handlers) runPredictionEvaluation(ctx context.Context, runID string) {
	if h.checkpointEvaluator != nil {
		h.checkpointEvaluator.Evaluate(ctx, runID)
	}
	if h.forecastEvaluator != nil {
		h.forecastEvaluator.Evaluate(ctx, runID)
	}
}

// validateRunBearerToken verifies the Authorization Bearer token for a run write.
// Callers write the HTTP response using the returned status and message when ok is false.
func validateRunBearerToken(r *http.Request, runID string) (status int, message string, ok bool) {
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		log.Printf("No authorization header provided for run_id: %s from %s", runID, r.RemoteAddr)
		return http.StatusUnauthorized, "Authorization header required", false
	}

	tokenParts := strings.Split(authHeader, " ")
	if len(tokenParts) != 2 || tokenParts[0] != "Bearer" {
		log.Printf("Invalid authorization header format for run_id: %s from %s", runID, r.RemoteAddr)
		return http.StatusUnauthorized, "Invalid authorization header format", false
	}

	token := tokenParts[1]
	valid, err := auth.ValidateToken(token, runID)
	if err != nil {
		log.Printf("Token validation failed for run_id: %s: %v", runID, err)
		return http.StatusUnauthorized, "Token validation failed", false
	}

	if !valid {
		log.Printf("Invalid token for run_id: %s from %s", runID, r.RemoteAddr)
		return http.StatusUnauthorized, "Invalid token", false
	}

	return 0, "", true
}

// Health returns a simple health check
func (h *Handlers) Health(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "healthy"})
}

// Auth generates a JWT token for a run
func (h *Handlers) Auth(w http.ResponseWriter, r *http.Request) {
	// Extract run_id from URL path
	runID := strings.TrimPrefix(r.URL.Path, "/auth/run/")
	if runID == "" {
		http.Error(w, "run_id is required", http.StatusBadRequest)
		return
	}

	mode := r.URL.Query().Get("prediction_mode")
	legacy := boolQuery(r, "predictive_reliability")
	switch mode {
	case "", "disabled", "reliability", "forecast", "predict":
	default:
		http.Error(w, "invalid prediction_mode", http.StatusBadRequest)
		return
	}
	if legacy && mode != "" && mode != "reliability" {
		http.Error(w, "conflicting prediction settings", http.StatusBadRequest)
		return
	}
	if mode == "" && legacy {
		mode = "reliability"
	}
	if h.storage != nil && mode != "" && mode != "disabled" {
		if err := h.storage.SetRunPredictionMode(runID, mode); err != nil {
			log.Printf("Warning: could not persist prediction mode for run %s: %v", runID, err)
		}
	}
	if h.storage != nil && r.URL.Query().Get("export_to_bigquery") == "true" {
		if err := h.storage.SetRunExportToBigquery(runID, true); err != nil {
			log.Printf("Warning: could not persist export_to_bigquery for run %s: %v", runID, err)
		}
	}
	if h.storage != nil && mode == "reliability" {
		if err := h.storage.SetRunPredictiveReliability(runID, true); err != nil {
			log.Printf("Warning: could not persist predictive_reliability for run %s: %v", runID, err)
		}
	}

	log.Printf("🔐 Auth request for run_id: %s", runID)

	// Generate token
	token, expiresAt, err := auth.GenerateToken(runID)
	if err != nil {
		log.Printf("Failed to generate token: %v", err)
		http.Error(w, "Failed to generate token", http.StatusInternalServerError)
		return
	}

	response := models.TokenResponse{
		Token:     token,
		ExpiresAt: expiresAt,
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	json.NewEncoder(w).Encode(response)

	log.Printf("✅ Generated token for run_id: %s, expires at: %s", runID, expiresAt.Format(time.RFC3339))
}

// Ingest receives and stores monitoring data
func (h *Handlers) Ingest(w http.ResponseWriter, r *http.Request) {
	requestReceivedAt := time.Now()
	log.Printf("=== INGEST HANDLER CALLED ===")
	log.Printf("Method: %s", r.Method)
	log.Printf("Headers: %v", r.Header)

	// Handle CORS preflight
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method != http.MethodPost {
		log.Printf("Wrong method: %s", r.Method)
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Parse request body to get run_id
	var req models.IngestRequest

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		log.Printf("Failed to parse request body: %v", err)
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}

	if status, message, ok := validateRunBearerToken(r, req.RunID); !ok {
		http.Error(w, message, status)
		return
	}

	log.Printf("✅ Token validated successfully for run_id: %s", req.RunID)

	if req.RunID == "" {
		http.Error(w, "Missing run_id", http.StatusBadRequest)
		return
	}

	// Allow empty data if ProcessInfo is provided (for VM flags-only requests)
	if req.Data == "" && req.ProcessInfo == nil {
		http.Error(w, "Missing data or process_info", http.StatusBadRequest)
		return
	}

	// Handle process info first (if provided) - this can work independently
	if req.ProcessInfo != nil {
		if err := h.storage.StoreProcessInfo(req.RunID, *req.ProcessInfo); err != nil {
			log.Printf("Failed to store process info: %v", err)
			// Don't fail the request if process info storage fails, just log it
		} else {
			log.Printf("✅ Stored process info for PID: %s", req.ProcessInfo.PID)
		}
	}

	// If no data provided, we're done (process info was handled above)
	if req.Data == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]string{"status": "success", "process_info": "stored"})
		return
	}

	// Get the run to determine its StartTime
	var startTime time.Time
	runDoc, err := h.storage.GetRun(req.RunID)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			// New run, use current time
			startTime = time.Now()
			log.Printf("New run, using current time as StartTime: %v", startTime)
		} else {
			log.Printf("Error getting run document: %v", err)
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}
	} else {
		startTime = runDoc.StartTime
		if startTime.IsZero() {
			startTime = time.Now()
			log.Printf("Run %s had no StartTime yet; using current time: %v", req.RunID, startTime)
		}
		log.Printf("Using existing StartTime: %v", startTime)
	}

	// Parse the data with StartTime for consistent timestamps
	samples, err := storage.ParseData(req.Data, startTime)
	if err != nil {
		log.Printf("Failed to parse data: %v", err)
		http.Error(w, "Invalid data format", http.StatusBadRequest)
		return
	}
	if req.Freshness != nil {
		if len(samples) != 1 || !validFreshness(req.Freshness) {
			http.Error(w, "Invalid freshness metadata", http.StatusBadRequest)
			return
		}
		samples[0].Freshness = &models.FreshnessTiming{
			SampleID:                req.Freshness.SampleID,
			Sequence:                req.Freshness.Sequence,
			CollectedAtUnixMs:       req.Freshness.CollectedAtUnixMs,
			BackendReceivedAtUnixMs: requestReceivedAt.UnixMilli(),
			BackendReceivedAt:       requestReceivedAt,
		}
	}

	// Store in Firestore
	if err := h.storage.StoreSamples(req.RunID, samples); err != nil {
		log.Printf("Failed to store samples: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	// Enqueue prediction off this request. Never run TabFM/TimesFM here: Cloud Run
	// holds the client until the handler returns even after Flush.
	maxElapsed := maxSampleElapsed(samples)
	if h.predictionScheduler != nil {
		if err := h.predictionScheduler.Schedule(r.Context(), req.RunID, maxElapsed); err != nil {
			predictionqueue.LogScheduleError(req.RunID, err)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(map[string]string{"status": "success", "samples": fmt.Sprintf("%d", len(samples))}); err != nil {
		log.Printf("Failed to encode ingest response for run %s: %v", req.RunID, err)
	}
}

func maxSampleElapsed(samples []models.Sample) int {
	maxElapsed := 0
	for _, sample := range samples {
		if sample.ElapsedTime > maxElapsed {
			maxElapsed = sample.ElapsedTime
		}
	}
	return maxElapsed
}

// EvaluatePredictionJob runs checkpoint/forecast evaluation for a Cloud Tasks job.
// Auth is a shared secret header — not the run JWT — so Tasks can invoke it.
func (h *Handlers) EvaluatePredictionJob(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, "+predictionJobTokenHeader)
		w.WriteHeader(http.StatusOK)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if h.predictionJobToken == "" || r.Header.Get(predictionJobTokenHeader) != h.predictionJobToken {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		http.Error(w, "Invalid request body", http.StatusBadRequest)
		return
	}
	job, err := predictionqueue.DecodeJob(body)
	if err != nil {
		http.Error(w, "Invalid job payload", http.StatusBadRequest)
		return
	}

	evalCtx, cancel := context.WithTimeout(r.Context(), predictionJobTimeout)
	defer cancel()
	h.runPredictionEvaluation(evalCtx, job.RunID)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "success", "run_id": job.RunID})
}

func validFreshness(value *models.IngestFreshness) bool {
	if value == nil || value.SampleID == "" || len(value.SampleID) > 128 || value.Sequence <= 0 || value.CollectedAtUnixMs <= 0 {
		return false
	}
	for _, char := range value.SampleID {
		if (char < '0' || char > '9') && char != '-' {
			return false
		}
	}
	return true
}

func boolQuery(r *http.Request, key string) bool {
	enabled, err := strconv.ParseBool(strings.TrimSpace(r.URL.Query().Get(key)))
	return err == nil && enabled
}

// GetRun retrieves run data
func (h *Handlers) GetRun(w http.ResponseWriter, r *http.Request) {
	log.Printf("runsHandler called with path: %s, method: %s", r.URL.Path, r.Method)

	// Handle CORS preflight
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Extract run_id from URL path
	path := strings.TrimPrefix(r.URL.Path, "/runs/")
	log.Printf("Extracted path: %s", path)
	if path == "" {
		http.Error(w, "Run ID required", http.StatusBadRequest)
		return
	}

	runID := path
	log.Printf("Fetching data for run ID: %s", runID)

	runDoc, err := h.storage.GetRun(runID)
	if err != nil {
		log.Printf("Error getting run document: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	// Auto-finish stale runs after 5 minutes without updates.
	if !runDoc.Finished && time.Since(runDoc.UpdatedAt) > 5*time.Minute {
		log.Printf("Run %s stale for >5m; auto-finishing", runID)
		if newlyFinished, err := h.storage.MarkRunAsFinished(runID); err != nil {
			log.Printf("Failed to auto-finish run %s: %v", runID, err)
		} else {
			now := time.Now()
			runDoc.Finished = true
			runDoc.FinishedAt = now
			runDoc.UpdatedAt = now
			if newlyFinished && h.export != nil {
				h.export.Run(runID)
			}
		}
	}

	// Get process info from processes collection
	processDoc, err := h.storage.GetProcesses(runID)
	if err != nil {
		log.Printf("Warning: Failed to get process info for run %s: %v", runID, err)
		// Continue without process info rather than failing
		processDoc = &models.ProcessDoc{
			RunID:       runID,
			ProcessInfo: make(map[string]models.ProcessInfo),
		}
	}

	var response models.RunResponse
	response.Samples = runDoc.Samples
	response.ProcessInfo = processDoc.ProcessInfo
	response.PredictionCheckpoints = runDoc.PredictionCheckpoints
	response.ProcessForecasts = runDoc.ProcessForecasts
	response.Finished = runDoc.Finished
	response.UpdatedAt = runDoc.UpdatedAt
	if !runDoc.FinishedAt.IsZero() {
		response.FinishedAt = &runDoc.FinishedAt
	}

	log.Printf("Found %d samples for run ID %s, finished: %v", len(response.Samples), runID, response.Finished)

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding response: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
}

// FinishRun marks a run as finished (requires JWT)
func (h *Handlers) FinishRun(w http.ResponseWriter, r *http.Request) {
	log.Printf("finishHandler called with path: %s, method: %s", r.URL.Path, r.Method)

	// Handle CORS preflight
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Extract run_id from URL path
	runID := strings.TrimPrefix(r.URL.Path, "/finish/")
	if runID == "" {
		http.Error(w, "Run ID required", http.StatusBadRequest)
		return
	}

	if status, message, ok := validateRunBearerToken(r, runID); !ok {
		http.Error(w, message, status)
		return
	}

	log.Printf("✅ Token validated successfully for finishing run: %s", runID)
	log.Printf("Manually finishing run: %s", runID)

	newlyFinished, err := h.storage.MarkRunAsFinished(runID)
	if err != nil {
		log.Printf("Error finishing run %s: %v", runID, err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	if newlyFinished && h.export != nil {
		h.export.Run(runID)
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"message": fmt.Sprintf("Run %s marked as finished", runID),
	})

	log.Printf("✅ Successfully marked run %s as finished", runID)
}
