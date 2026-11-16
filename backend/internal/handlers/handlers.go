package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/cdsap/build-process-watcher/backend/internal/models"
	"github.com/cdsap/build-process-watcher/backend/internal/prediction"
	"github.com/cdsap/build-process-watcher/backend/internal/predictionqueue"
	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
)

const predictionJobTokenHeader = "X-BPW-Prediction-Job-Token"

// Handlers contains all HTTP handlers.
type Handlers struct {
	storage             Storage
	export              Exporter
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

// Health returns a simple health check.
func (h *Handlers) Health(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(map[string]string{"status": "healthy"})
}
