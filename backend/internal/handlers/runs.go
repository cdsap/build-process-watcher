package handlers

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/models"
	"github.com/cdsap/build-process-watcher/backend/internal/storage"
)

// GetRun retrieves run data
func (h *Handlers) GetRun(w http.ResponseWriter, r *http.Request) {
	log.Printf("runsHandler called with path: %s, method: %s", r.URL.Path, r.Method)

	if handleCORSPreflight(w, r, corsMethodsGET, corsHeadersJSON) {
		return
	}
	if !requireMethod(w, r, http.MethodGet) {
		return
	}

	path := strings.TrimPrefix(r.URL.Path, "/runs/")
	log.Printf("Extracted path: %s", path)
	if path == "" {
		http.Error(w, "Run ID required", http.StatusBadRequest)
		return
	}

	runID := path
	log.Printf("Fetching data for run ID: %s", runID)

	runDoc, err := h.storage.GetRun(r.Context(), runID)
	if err != nil {
		if storage.IsNotFound(err) {
			http.Error(w, "Run not found", http.StatusNotFound)
			return
		}
		log.Printf("Error getting run document: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	if h.lifecycle.IsStale(runDoc.UpdatedAt, runDoc.Finished) {
		if _, err := h.lifecycle.Finish(r.Context(), runID); err != nil {
			log.Printf("Failed to auto-finish run %s: %v", runID, err)
		} else {
			now := time.Now()
			runDoc.Finished = true
			runDoc.FinishedAt = now
			runDoc.UpdatedAt = now
		}
	}

	processDoc, err := h.storage.GetProcesses(r.Context(), runID)
	if err != nil {
		log.Printf("Warning: Failed to get process info for run %s: %v", runID, err)
		processDoc = &models.ProcessDoc{
			RunID:       runID,
			ProcessInfo: make(map[string]models.ProcessInfo),
		}
	}

	var response models.RunResponse
	response.Samples = runDoc.Samples
	response.ProcessInfo = processDoc.ProcessInfo
	response.PredictionMode = runDoc.PredictionMode
	response.PredictionThrottleS = runDoc.PredictionThrottleS
	response.PredictionCheckpoints = runDoc.PredictionCheckpoints
	response.ProcessForecasts = runDoc.ProcessForecasts
	response.Finished = runDoc.Finished
	response.UpdatedAt = runDoc.UpdatedAt
	if !runDoc.FinishedAt.IsZero() {
		response.FinishedAt = &runDoc.FinishedAt
	}

	log.Printf("Found %d samples for run ID %s, finished: %v", len(response.Samples), runID, response.Finished)

	w.Header().Set("Content-Type", "application/json")
	setCORSHeaders(w, corsMethodsGET, corsHeadersJSON)

	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding response: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
}

// FinishRun marks a run as finished (requires JWT)
func (h *Handlers) FinishRun(w http.ResponseWriter, r *http.Request) {
	log.Printf("finishHandler called with path: %s, method: %s", r.URL.Path, r.Method)

	if handleCORSPreflight(w, r, corsMethodsPOST, corsHeadersAuth) {
		return
	}
	if !requireMethod(w, r, http.MethodPost) {
		return
	}

	runID := strings.TrimPrefix(r.URL.Path, "/finish/")
	if runID == "" {
		http.Error(w, "Run ID required", http.StatusBadRequest)
		return
	}

	if status, message, ok := h.validateRunBearerToken(r, runID); !ok {
		http.Error(w, message, status)
		return
	}

	log.Printf("✅ Token validated successfully for finishing run: %s", runID)
	log.Printf("Manually finishing run: %s", runID)

	if _, err := h.lifecycle.Finish(r.Context(), runID); err != nil {
		log.Printf("Error finishing run %s: %v", runID, err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	setCORSHeaders(w, "", "")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"message": fmt.Sprintf("Run %s marked as finished", runID),
	})

	log.Printf("✅ Successfully marked run %s as finished", runID)
}
