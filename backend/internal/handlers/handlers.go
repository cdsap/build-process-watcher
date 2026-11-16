package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/auth"
	"github.com/cdsap/build-process-watcher/backend/internal/models"
	"github.com/cdsap/build-process-watcher/backend/internal/prediction"
	"github.com/cdsap/build-process-watcher/backend/internal/predictionqueue"
	"github.com/cdsap/build-process-watcher/backend/internal/runlifecycle"
	"github.com/cdsap/build-process-watcher/backend/internal/storage"
	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
)

// predictionJobTimeout bounds checkpoint/forecast work on the job handler.
// TabFM regularly takes 30–45s (BigQuery AI.PREDICT + fallback); keep this above
// PREDICTIVE_TABPREDICT_PROVIDER_TIMEOUT_MS (default 20s, prod often 60s).
const predictionJobTimeout = 90 * time.Second

// Handlers contains all HTTP handlers
type Handlers struct {
	storage             Storage
	export              Exporter
	authn               *auth.Authenticator
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
	GetRun(ctx context.Context, runID string) (*models.RunDoc, error)
	GetProcesses(ctx context.Context, runID string) (*models.ProcessDoc, error)
	AppendSamples(ctx context.Context, runID string, build storage.SampleBuildFunc) (*storage.SampleAppendResult, error)
	StoreProcessInfo(ctx context.Context, runID string, processInfo models.ProcessInfo) error
	StorePredictionCheckpoint(ctx context.Context, runID string, checkpoint models.PredictionCheckpoint) error
	AppendProcessForecasts(ctx context.Context, runID string, forecasts []models.ProcessForecast) error
	SetRunExportToBigquery(ctx context.Context, runID string, enabled bool) error
	SetRunPredictiveReliability(ctx context.Context, runID string, enabled bool) error
	SetRunPredictionMode(ctx context.Context, runID, mode string) error
	MarkRunAsFinished(ctx context.Context, runID string) (bool, error)
}

// Exporter is the export scheduling port used by the HTTP handlers. The
// production implementation is exportqueue.Scheduler.
type Exporter interface {
	Run(runID string)
}

// Config wires HTTP handlers without a long positional constructor.
type Config struct {
	Storage             Storage
	Export              Exporter
	ReliabilityProvider predictor.Provider
	Checkpoints         []int
	FallbackClassifier  predictor.FallbackClassifier
	TimelineProviders   prediction.TimelineProviders
	Authenticator       *auth.Authenticator
	PredictionScheduler predictionqueue.Scheduler
	PredictionJobToken  string
}

// New constructs handlers from Config.
func New(cfg Config) *Handlers {
	var checkpointRepo prediction.CheckpointRepository
	var forecastRepo prediction.ForecastRepository
	if cfg.Storage != nil {
		checkpointRepo = cfg.Storage
		forecastRepo = cfg.Storage
	}
	reliability := cfg.ReliabilityProvider
	if reliability == nil {
		reliability = predictor.NoopProvider{}
	}
	h := &Handlers{
		storage:             cfg.Storage,
		export:              cfg.Export,
		authn:               cfg.Authenticator,
		lifecycle:           runlifecycle.New(cfg.Storage, cfg.Export),
		checkpointEvaluator: prediction.NewCheckpointEvaluator(checkpointRepo, reliability, cfg.Checkpoints, cfg.FallbackClassifier),
		forecastEvaluator:   prediction.NewForecastEvaluator(forecastRepo, cfg.TimelineProviders),
		predictionScheduler: predictionqueue.Noop{},
	}
	h.SetPredictionScheduler(cfg.PredictionScheduler, cfg.PredictionJobToken)
	return h
}

// NewHandlers creates a handlers instance with noop predictors. export may be nil.
func NewHandlers(storageClient Storage, export Exporter) *Handlers {
	return New(Config{Storage: storageClient, Export: export})
}

// SetAuthenticator installs the JWT/admin authenticator used by auth and ingest.
func (h *Handlers) SetAuthenticator(authenticator *auth.Authenticator) {
	if h == nil {
		return
	}
	h.authn = authenticator
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
