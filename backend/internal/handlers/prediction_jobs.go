package handlers

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/predictionqueue"
)

// predictionJobTimeout bounds checkpoint/forecast work on the job handler.
// TabFM regularly takes 30–45s (BigQuery AI.PREDICT + fallback); keep this above
// PREDICTIVE_TABPREDICT_PROVIDER_TIMEOUT_MS (default 20s, prod often 60s).
const predictionJobTimeout = 90 * time.Second

// EvaluatePredictionJob runs checkpoint/forecast evaluation for a Cloud Tasks job.
// Auth is a shared secret header — not the run JWT — so Tasks can invoke it.
func (h *Handlers) EvaluatePredictionJob(w http.ResponseWriter, r *http.Request) {
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
