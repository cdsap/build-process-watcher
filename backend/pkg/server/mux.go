package server

import (
	"net/http"

	"github.com/cdsap/build-process-watcher/backend/internal/cleanup"
	"github.com/cdsap/build-process-watcher/backend/internal/handlers"
)

// NewMux registers backend routes on a new ServeMux.
func NewMux(h *handlers.Handlers, cleanupService *cleanup.Service) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", h.Health)
	mux.HandleFunc("/auth/run/", h.Auth)
	mux.HandleFunc("/ingest", h.Ingest)
	mux.HandleFunc("/internal/prediction-jobs", h.EvaluatePredictionJob)
	mux.HandleFunc("/runs/", h.GetRun)
	mux.HandleFunc("/finish/", h.FinishRun)
	mux.HandleFunc("/cleanup/stale", cleanupService.HandleManualStaleCleanup)
	return mux
}
