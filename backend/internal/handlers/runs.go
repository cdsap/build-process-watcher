package handlers

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/models"
)

// GetRun retrieves run data.
func (h *Handlers) GetRun(w http.ResponseWriter, r *http.Request) {
	log.Printf("runsHandler called with path: %s, method: %s", r.URL.Path, r.Method)
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

	processDoc, err := h.storage.GetProcesses(runID)
	if err != nil {
		log.Printf("Warning: Failed to get process info for run %s: %v", runID, err)
		processDoc = &models.ProcessDoc{RunID: runID, ProcessInfo: make(map[string]models.ProcessInfo)}
	}
	response := models.RunResponse{
		Samples:               runDoc.Samples,
		ProcessInfo:           processDoc.ProcessInfo,
		PredictionCheckpoints: runDoc.PredictionCheckpoints,
		ProcessForecasts:      runDoc.ProcessForecasts,
		Finished:              runDoc.Finished,
		UpdatedAt:             runDoc.UpdatedAt,
	}
	if !runDoc.FinishedAt.IsZero() {
		response.FinishedAt = &runDoc.FinishedAt
	}

	log.Printf("Found %d samples for run ID %s, finished: %v", len(response.Samples), runID, response.Finished)
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(response); err != nil {
		log.Printf("Error encoding response: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
	}
}

// FinishRun marks a run as finished (requires JWT).
func (h *Handlers) FinishRun(w http.ResponseWriter, r *http.Request) {
	log.Printf("finishHandler called with path: %s, method: %s", r.URL.Path, r.Method)
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
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"status":  "success",
		"message": fmt.Sprintf("Run %s marked as finished", runID),
	})
	log.Printf("✅ Successfully marked run %s as finished", runID)
}
