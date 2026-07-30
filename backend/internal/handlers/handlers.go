package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/auth"
	"github.com/cdsap/build-process-watcher/backend/internal/exportqueue"
	"github.com/cdsap/build-process-watcher/backend/internal/models"
	"github.com/cdsap/build-process-watcher/backend/internal/storage"
	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
)

// Handlers contains all HTTP handlers
type Handlers struct {
	storage              *storage.Client
	export               *exportqueue.Scheduler
	predictor            predictor.Provider
	predictorCheckpoints []int
}

// NewHandlers creates a new handlers instance. export may be nil (no BigQuery jobs).
func NewHandlers(storageClient *storage.Client, export *exportqueue.Scheduler) *Handlers {
	return NewHandlersWithPredictor(storageClient, export, predictor.NoopProvider{}, nil)
}

// NewHandlersWithPredictor creates handlers with an optional prediction provider.
func NewHandlersWithPredictor(storageClient *storage.Client, export *exportqueue.Scheduler, predictionProvider predictor.Provider, checkpoints []int) *Handlers {
	if predictionProvider == nil {
		predictionProvider = predictor.NoopProvider{}
	}
	return &Handlers{
		storage:              storageClient,
		export:               export,
		predictor:            predictionProvider,
		predictorCheckpoints: checkpoints,
	}
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

	if h.storage != nil && r.URL.Query().Get("export_to_bigquery") == "true" {
		if err := h.storage.SetRunExportToBigquery(runID, true); err != nil {
			log.Printf("Warning: could not persist export_to_bigquery for run %s: %v", runID, err)
		}
	}
	if h.storage != nil && boolQuery(r, "predictive_reliability") {
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

	// Verify token
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		log.Printf("No authorization header provided")
		http.Error(w, "Authorization header required", http.StatusUnauthorized)
		return
	}

	// Extract token from "Bearer <token>"
	tokenParts := strings.Split(authHeader, " ")
	if len(tokenParts) != 2 || tokenParts[0] != "Bearer" {
		log.Printf("Invalid authorization header format")
		http.Error(w, "Invalid authorization header format", http.StatusUnauthorized)
		return
	}

	token := tokenParts[1]
	valid, err := auth.ValidateToken(token, req.RunID)
	if err != nil {
		log.Printf("Token validation failed: %v", err)
		http.Error(w, "Token validation failed", http.StatusUnauthorized)
		return
	}

	if !valid {
		log.Printf("Invalid token for run_id: %s", req.RunID)
		http.Error(w, "Invalid token", http.StatusUnauthorized)
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

	// Store in Firestore
	if err := h.storage.StoreSamples(req.RunID, samples); err != nil {
		log.Printf("Failed to store samples: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	h.evaluatePredictionCheckpoints(r.Context(), req.RunID)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "success", "samples": fmt.Sprintf("%d", len(samples))})
}

func (h *Handlers) evaluatePredictionCheckpoints(ctx context.Context, runID string) {
	if h.storage == nil || !predictor.Enabled(h.predictor) || len(h.predictorCheckpoints) == 0 {
		return
	}

	runDoc, err := h.storage.GetRun(runID)
	if err != nil {
		log.Printf("Prediction skipped: could not load run %s: %v", runID, err)
		return
	}
	if !runDoc.PredictiveReliability {
		return
	}
	processDoc, err := h.storage.GetProcesses(runID)
	if err != nil {
		log.Printf("Prediction continuing without process info for run %s: %v", runID, err)
		processDoc = &models.ProcessDoc{
			RunID:       runID,
			ProcessInfo: make(map[string]models.ProcessInfo),
		}
	}

	pending := predictor.PendingCheckpoints(runDoc.Samples, runDoc.PredictionCheckpoints, h.predictorCheckpoints)
	for _, checkpointWindow := range pending {
		checkpoint, err := h.predictor.Predict(ctx, predictor.RunSnapshot{
			RunID:                 runID,
			Samples:               runDoc.Samples,
			ProcessInfo:           processDoc.ProcessInfo,
			ExistingCheckpoints:   runDoc.PredictionCheckpoints,
			ConfiguredCheckpoints: h.predictorCheckpoints,
			Now:                   time.Now(),
		}, checkpointWindow)
		if err != nil {
			checkpoint = models.PredictionCheckpoint{
				ObservationWindowS: checkpointWindow,
				Status:             "error",
				CreatedAt:          time.Now(),
				Message:            "prediction provider error",
			}
			log.Printf("Prediction provider failed for run %s checkpoint %ds: %v", runID, checkpointWindow, err)
		}
		if checkpoint.ObservationWindowS == 0 {
			checkpoint.ObservationWindowS = checkpointWindow
		}
		if checkpoint.CreatedAt.IsZero() {
			checkpoint.CreatedAt = time.Now()
		}
		if err := h.storage.StorePredictionCheckpoint(runID, checkpoint); err != nil {
			log.Printf("Prediction checkpoint store failed for run %s checkpoint %ds: %v", runID, checkpointWindow, err)
		}
	}
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

	// Verify JWT token
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		log.Printf("⚠️  Finish request without authorization from %s for run: %s", r.RemoteAddr, runID)
		http.Error(w, "Authorization header required", http.StatusUnauthorized)
		return
	}

	// Extract token from "Bearer <token>"
	tokenParts := strings.Split(authHeader, " ")
	if len(tokenParts) != 2 || tokenParts[0] != "Bearer" {
		log.Printf("⚠️  Invalid authorization header format from %s", r.RemoteAddr)
		http.Error(w, "Invalid authorization header format", http.StatusUnauthorized)
		return
	}

	token := tokenParts[1]
	valid, err := auth.ValidateToken(token, runID)
	if err != nil {
		log.Printf("⚠️  Token validation failed for run %s: %v", runID, err)
		http.Error(w, "Token validation failed", http.StatusUnauthorized)
		return
	}

	if !valid {
		log.Printf("⚠️  Invalid token for run %s from %s", runID, r.RemoteAddr)
		http.Error(w, "Invalid token", http.StatusUnauthorized)
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
