package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/models"
	"github.com/cdsap/build-process-watcher/backend/internal/predictionqueue"
	"github.com/cdsap/build-process-watcher/backend/internal/telemetry"
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

	if status, message, ok := h.validateRunBearerToken(r, req.RunID); !ok {
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
		if err := h.storage.StoreProcessInfo(r.Context(), req.RunID, *req.ProcessInfo); err != nil {
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

	var maxElapsed int
	appendResult, err := h.storage.AppendSamples(r.Context(), req.RunID, func(startTime time.Time) ([]models.Sample, error) {
		samples, err := telemetry.ParseData(req.Data, startTime)
		if err != nil {
			return nil, err
		}
		if req.MetricMeasurements != nil {
			if len(samples) != 1 || !validMetricMeasurements(req.MetricMeasurements) {
				return nil, errInvalidMeasurements
			}
			samples[0].MetricMeasurements = req.MetricMeasurements
		}
		if req.Freshness != nil {
			if len(samples) != 1 || !validFreshness(req.Freshness) {
				return nil, errInvalidFreshness
			}
			samples[0].Freshness = &models.FreshnessTiming{
				SampleID:                req.Freshness.SampleID,
				Sequence:                req.Freshness.Sequence,
				CollectedAtUnixMs:       req.Freshness.CollectedAtUnixMs,
				BackendReceivedAtUnixMs: requestReceivedAt.UnixMilli(),
				BackendReceivedAt:       requestReceivedAt,
			}
		}
		maxElapsed = maxSampleElapsed(samples)
		return samples, nil
	})
	if err != nil {
		if errors.Is(err, errInvalidMeasurements) {
			http.Error(w, "Invalid metric measurements", http.StatusBadRequest)
			return
		}
		if errors.Is(err, errInvalidFreshness) {
			http.Error(w, "Invalid freshness metadata", http.StatusBadRequest)
			return
		}
		log.Printf("Failed to store samples: %v", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	mode := models.NormalizePredictionMode(appendResult.PredictionMode)
	throttleS := models.NormalizeThrottleElapsedS(appendResult.PredictionThrottleS)
	if h.predictionScheduler != nil && models.ShouldEnqueuePrediction(mode, appendResult.PredictiveReliability) {
		if err := h.predictionScheduler.Schedule(r.Context(), req.RunID, maxElapsed, throttleS); err != nil {
			predictionqueue.LogScheduleError(req.RunID, err)
		}
	} else if h.predictionScheduler != nil {
		log.Printf("Skipping prediction schedule for run %s (mode=%q)", req.RunID, mode)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	if err := json.NewEncoder(w).Encode(map[string]string{"status": "success", "samples": fmt.Sprintf("%d", appendResult.Count)}); err != nil {
		log.Printf("Failed to encode ingest response for run %s: %v", req.RunID, err)
	}
}

var errInvalidFreshness = fmt.Errorf("invalid freshness metadata")

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

var errInvalidMeasurements = fmt.Errorf("invalid metric measurements")

func validMetricMeasurements(value *models.MetricMeasurements) bool {
	const maxSafeInteger int64 = 9007199254740991
	for _, t := range []int64{value.ProcessStartTimeMs, value.JITSampledAtMs, value.ClassesSampledAtMs} {
		if t < 0 || t > maxSafeInteger {
			return false
		}
	}
	for _, t := range []int64{value.JITSampledAtMs, value.ClassesSampledAtMs} {
		if t > 0 && value.ProcessStartTimeMs > t {
			return false
		}
	}
	return true
}
