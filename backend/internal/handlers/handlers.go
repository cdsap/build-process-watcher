package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/models"
	"github.com/cdsap/build-process-watcher/backend/internal/prediction"
	"github.com/cdsap/build-process-watcher/backend/internal/predictionqueue"
	"github.com/cdsap/build-process-watcher/backend/internal/runlifecycle"
	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
)

// predictionJobTimeout bounds checkpoint/forecast work on the job handler.
// TabFM regularly takes 30–45s (BigQuery AI.PREDICT + fallback); keep this above
// PREDICTIVE_TABPREDICT_PROVIDER_TIMEOUT_MS (default 20s, prod often 60s).
const predictionJobTimeout = 90 * time.Second

const predictionJobTokenHeader = "X-BPW-Prediction-Job-Token"

// Handlers contains all HTTP handlers
type Handlers struct {
	storage             Storage
	export              Exporter
	lifecycle           *runlifecycle.Service
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
	return NewHandlersWithPredictor(storageClient, export, predictor.NoopProvider{}, nil, nil, predictor.NoopForecastProvider{}, predictor.NoopForecastProvider{}, predictor.NoopForecastProvider{})
}

// NewHandlersWithPredictor creates handlers with optional reliability and timeline
// providers (forecast / tabpredict / bqml-boosted) plus an optional fallback classifier.
func NewHandlersWithPredictor(storageClient Storage, export Exporter, predictionProvider predictor.Provider, checkpoints []int, fallbackClassifier predictor.FallbackClassifier, forecastProvider, tabPredictProvider, bqmlBoostedProvider predictor.ForecastProvider) *Handlers {
	var checkpointRepo prediction.CheckpointRepository
	var forecastRepo prediction.ForecastRepository
	if storageClient != nil {
		checkpointRepo = storageClient
		forecastRepo = storageClient
	}
	return &Handlers{
		storage:             storageClient,
		export:              export,
		lifecycle:           runlifecycle.New(storageClient, export),
		checkpointEvaluator: prediction.NewCheckpointEvaluator(checkpointRepo, predictionProvider, checkpoints, fallbackClassifier),
		forecastEvaluator:   prediction.NewForecastEvaluatorWithProviders(forecastRepo, forecastProvider, tabPredictProvider, bqmlBoostedProvider),
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

// Health returns a simple health check
func (h *Handlers) Health(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "healthy"})
}
