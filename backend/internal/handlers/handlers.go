package handlers

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/auth"
	"github.com/cdsap/build-process-watcher/backend/internal/models"
	"github.com/cdsap/build-process-watcher/backend/internal/prediction"
	"github.com/cdsap/build-process-watcher/backend/internal/predictionqueue"
	"github.com/cdsap/build-process-watcher/backend/internal/runlifecycle"
	"github.com/cdsap/build-process-watcher/backend/internal/storage"
)

// predictionJobTimeout bounds forecast work on the job handler.
// TabFM regularly takes 30–45s (BigQuery AI.PREDICT + fallback); keep this above
// PREDICTIVE_TABPREDICT_PROVIDER_TIMEOUT_MS (default 20s, prod often 60s).
const predictionJobTimeout = 90 * time.Second

// Handlers contains all HTTP handlers
type Handlers struct {
	storage           Storage
	export            Exporter
	authn             RunAuthenticator
	lifecycle         *runlifecycle.Service
	forecastEvaluator *prediction.ForecastEvaluator
	// predictionScheduler enqueues evaluation off the /ingest path (Cloud Tasks).
	predictionScheduler predictionqueue.Scheduler
	// predictionJobToken authorizes POST /internal/prediction-jobs.
	predictionJobToken string
}

// Storage is the persistence port used by the HTTP handlers.
// The production implementation is storage.Client.
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
	SetRunPredictionThrottleS(ctx context.Context, runID string, throttleS int) error
	MarkRunAsFinished(ctx context.Context, runID string) (bool, error)
}

// Exporter is the export scheduling port used by the HTTP handlers. The
// production implementation is exportqueue.Scheduler.
type Exporter interface {
	Run(runID string)
}

// RunAuthenticator issues and validates run JWTs for auth/ingest/finish.
// Production uses *auth.Authenticator.
type RunAuthenticator interface {
	GenerateToken(runID string) (token string, expiresAt time.Time, err error)
	ValidateRunBearer(r *http.Request, runID string) auth.BearerResult
}

// Config wires HTTP handlers without a long positional constructor.
type Config struct {
	Storage             Storage
	Export              Exporter
	TimelineProviders   prediction.TimelineProviders
	Authenticator       RunAuthenticator
	PredictionScheduler predictionqueue.Scheduler
	PredictionJobToken  string
}

// New constructs handlers from Config.
func New(cfg Config) *Handlers {
	var forecastRepo prediction.ForecastRepository
	if cfg.Storage != nil {
		forecastRepo = cfg.Storage
	}
	h := &Handlers{
		storage:             cfg.Storage,
		export:              cfg.Export,
		authn:               cfg.Authenticator,
		lifecycle:           runlifecycle.New(cfg.Storage, cfg.Export),
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

// SetAuthenticator installs the JWT run authenticator used by auth and ingest.
func (h *Handlers) SetAuthenticator(authenticator RunAuthenticator) {
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

// runPredictionEvaluation runs process forecasts for timeline prediction modes.
// Invoked only from the prediction job handler — never from /ingest.
func (h *Handlers) runPredictionEvaluation(ctx context.Context, runID string) {
	if h == nil {
		return
	}
	var runDoc *models.RunDoc
	if h.storage != nil {
		doc, err := h.storage.GetRun(ctx, runID)
		if err != nil {
			log.Printf("Prediction skipped: could not load run %s: %v", runID, err)
			return
		}
		runDoc = doc
	}
	if h.forecastEvaluator != nil {
		h.forecastEvaluator.EvaluateLoaded(ctx, runID, runDoc)
	}
}

// Health returns a simple health check
func (h *Handlers) Health(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "healthy"})
}
