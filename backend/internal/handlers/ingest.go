package handlers

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/models"
	"github.com/cdsap/build-process-watcher/backend/internal/predictionqueue"
	"github.com/cdsap/build-process-watcher/backend/internal/storage"
)

// Ingest receives and stores monitoring data
func (h *Handlers) Ingest(w http.ResponseWriter, r *http.Request) {
	requestReceivedAt := time.Now()

	if handleCORSPreflight(w, r, corsMethodsPOST, corsHeadersAuth) {
		return
	}
	if !requireMethod(w, r, http.MethodPost) {
		return
	}

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

	if req.ProcessInfo != nil {
		if err := h.storage.StoreProcessInfo(req.RunID, *req.ProcessInfo); err != nil {
			log.Printf("Failed to store process info: %v", err)
		} else {
			log.Printf("✅ Stored process info for PID: %s", req.ProcessInfo.PID)
		}
	}

	if req.Data == "" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]string{"status": "success", "process_info": "stored"})
		return
	}

	var startTime time.Time
	runDoc, err := h.storage.GetRun(req.RunID)
	if err != nil {
		if storage.IsNotFound(err) {
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

	if err := h.storage.StoreSamples(req.RunID, samples); err != nil {
		log.Printf("Failed to store samples: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

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
