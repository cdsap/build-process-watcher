package handlers

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"io"
	"net/http"

	"github.com/cdsap/build-process-watcher/backend/internal/predictionqueue"
)

// EvaluatePredictionJob runs checkpoint/forecast evaluation for a Cloud Tasks job.
// Auth is a shared secret header — not the run JWT — so Tasks can invoke it.
func (h *Handlers) EvaluatePredictionJob(w http.ResponseWriter, r *http.Request) {
	if handleCORSPreflight(w, r, corsMethodsPOST, "Content-Type, "+predictionJobTokenHeader) {
		return
	}
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	provided := r.Header.Get(predictionJobTokenHeader)
	if h.predictionJobToken == "" || subtle.ConstantTimeCompare([]byte(provided), []byte(h.predictionJobToken)) != 1 {
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
