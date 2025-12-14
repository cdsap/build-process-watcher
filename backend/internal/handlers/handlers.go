package handlers

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/auth"
	"github.com/cdsap/build-process-watcher/backend/internal/models"
	"github.com/cdsap/build-process-watcher/backend/internal/storage"
)

// Handlers contains all HTTP handlers
type Handlers struct {
	storage *storage.Client
}

// NewHandlers creates a new handlers instance
func NewHandlers(storageClient *storage.Client) *Handlers {
	return &Handlers{
		storage: storageClient,
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

	if req.RunID == "" || req.Data == "" {
		http.Error(w, "Missing run_id or data", http.StatusBadRequest)
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

	// Store process info if provided (VM flags for a new process)
	if req.ProcessInfo != nil {
		if err := h.storage.StoreProcessInfo(req.RunID, *req.ProcessInfo); err != nil {
			log.Printf("Failed to store process info: %v", err)
			// Don't fail the request if process info storage fails, just log it
		} else {
			log.Printf("✅ Stored process info for PID: %s", req.ProcessInfo.PID)
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "success", "samples": fmt.Sprintf("%d", len(samples))})
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

	var response models.RunResponse
	response.Samples = runDoc.Samples
	response.ProcessInfo = runDoc.ProcessInfo
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

	// Mark the run as finished
	err = h.storage.MarkRunAsFinished(runID)
	if err != nil {
		log.Printf("Error finishing run %s: %v", runID, err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
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

