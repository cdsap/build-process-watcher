package server

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/auth"
	"github.com/cdsap/build-process-watcher/backend/internal/bigqueryexport"
	"github.com/cdsap/build-process-watcher/backend/internal/cleanup"
	"github.com/cdsap/build-process-watcher/backend/internal/exportqueue"
	"github.com/cdsap/build-process-watcher/backend/internal/handlers"
	"github.com/cdsap/build-process-watcher/backend/internal/predictionqueue"
	"github.com/cdsap/build-process-watcher/backend/internal/storage"
	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
)

// Options configures the public backend server composition.
type Options struct {
	ProjectID              string
	Port                   string
	BigQueryDataset        string
	BigQueryTable          string
	BigQueryProcessesTable string
	PredictionProvider     predictor.Provider
	ForecastProvider       predictor.ForecastProvider
	TabPredictProvider     predictor.ForecastProvider
	BQMLBoostedProvider    predictor.ForecastProvider
	PredictionCheckpoints  []int
	// FallbackClassifier maps provider failures onto public-safe telemetry.
	// Composition roots (for example backend main) supply provider-specific
	// sentinel mapping; nil uses predictor.DefaultFallbackClassifier.
	FallbackClassifier predictor.FallbackClassifier

	// Prediction job queue (Cloud Tasks). Empty values disable the scheduler.
	PredictionTasksQueue    string
	PredictionTasksLocation string
	PredictionJobURL        string
	PredictionJobToken      string
	PredictionThrottleMode  string
}

type serverConfig struct {
	projectID                  string
	port                       string
	bigQueryDataset            string
	bigQueryTable              string
	bigQueryProcessesTable     string
	predictionProviderEnabled  bool
	predictionProviderURL      string
	predictionProviderAuth     string
	predictionProviderTime     time.Duration
	predictionCheckpoints      string
	forecastProviderEnabled    bool
	forecastProviderTimeout    time.Duration
	tabPredictProviderEnabled  bool
	tabPredictProviderTimeout  time.Duration
	bqmlBoostedProviderEnabled bool
	bqmlBoostedProviderTimeout time.Duration
}

// OptionsFromEnv reads public backend configuration from environment variables.
func OptionsFromEnv() Options {
	options, err := buildOptions(serverConfig{
		projectID:                  strings.TrimSpace(os.Getenv("GOOGLE_CLOUD_PROJECT")),
		port:                       os.Getenv("PORT"),
		bigQueryDataset:            strings.TrimSpace(os.Getenv("BIGQUERY_EXPORT_DATASET")),
		bigQueryTable:              strings.TrimSpace(os.Getenv("BIGQUERY_EXPORT_TABLE")),
		bigQueryProcessesTable:     strings.TrimSpace(os.Getenv("BIGQUERY_EXPORT_PROCESSES_TABLE")),
		predictionProviderEnabled:  predictionProviderEnabled(os.Getenv("PREDICTIVE_PROVIDER_ENABLED")),
		predictionProviderURL:      os.Getenv("PREDICTIVE_PROVIDER_URL"),
		predictionProviderAuth:     os.Getenv("PREDICTIVE_PROVIDER_AUTH_AUDIENCE"),
		predictionProviderTime:     parseRemoteProviderTimeout(os.Getenv("PREDICTIVE_PROVIDER_TIMEOUT_MS")),
		predictionCheckpoints:      os.Getenv("PREDICTIVE_RELIABILITY_CHECKPOINTS"),
		forecastProviderEnabled:    predictionProviderEnabled(firstNonEmpty(os.Getenv("PREDICTIVE_FORECAST_PROVIDER_ENABLED"), os.Getenv("PREDICTIVE_PROVIDER_ENABLED"))),
		forecastProviderTimeout:    parseForecastProviderTimeout(os.Getenv("PREDICTIVE_FORECAST_PROVIDER_TIMEOUT_MS")),
		tabPredictProviderEnabled:  predictionProviderEnabled(firstNonEmpty(os.Getenv("PREDICTIVE_TABPREDICT_PROVIDER_ENABLED"), os.Getenv("PREDICTIVE_PROVIDER_ENABLED"))),
		tabPredictProviderTimeout:  parseForecastProviderTimeout(firstNonEmpty(os.Getenv("PREDICTIVE_TABPREDICT_PROVIDER_TIMEOUT_MS"), os.Getenv("PREDICTIVE_FORECAST_PROVIDER_TIMEOUT_MS"))),
		bqmlBoostedProviderEnabled: predictionProviderEnabled(firstNonEmpty(os.Getenv("PREDICTIVE_BQML_BOOSTED_PROVIDER_ENABLED"), os.Getenv("PREDICTIVE_PROVIDER_ENABLED"))),
		bqmlBoostedProviderTimeout: parseForecastProviderTimeout(firstNonEmpty(os.Getenv("PREDICTIVE_BQML_BOOSTED_PROVIDER_TIMEOUT_MS"), os.Getenv("PREDICTIVE_FORECAST_PROVIDER_TIMEOUT_MS"))),
	})
	if err != nil {
		log.Printf("🔮 Remote predictive provider disabled: %v", err)
	}
	options.PredictionTasksQueue = strings.TrimSpace(os.Getenv("PREDICTION_TASKS_QUEUE"))
	options.PredictionTasksLocation = strings.TrimSpace(firstNonEmpty(os.Getenv("PREDICTION_TASKS_LOCATION"), "us-central1"))
	options.PredictionJobURL = strings.TrimSpace(os.Getenv("PREDICTION_JOB_URL"))
	options.PredictionJobToken = strings.TrimSpace(os.Getenv("PREDICTION_JOB_TOKEN"))
	options.PredictionThrottleMode = timelineThrottleModeFromEnv()
	return options
}

func buildOptions(config serverConfig) (Options, error) {
	provider := predictor.Provider(predictor.NoopProvider{})
	var providerErr error
	if config.predictionProviderEnabled {
		provider, providerErr = predictor.NewRemoteProvider(predictor.RemoteConfig{
			URL:          config.predictionProviderURL,
			Timeout:      config.predictionProviderTime,
			AuthAudience: config.predictionProviderAuth,
		})
		if providerErr != nil {
			provider = predictor.NoopProvider{}
		}
	}

	baseRemote := predictor.RemoteForecastConfig{
		URL:          config.predictionProviderURL,
		AuthAudience: config.predictionProviderAuth,
	}
	forecastProvider, tabPredictProvider, bqmlBoostedProvider, timelineErr := buildTimelineProviders(baseRemote, []timelineProviderSpec{
		{enabled: config.forecastProviderEnabled, timeout: config.forecastProviderTimeout, construct: predictor.NewRemoteForecastProvider},
		{enabled: config.tabPredictProviderEnabled, timeout: config.tabPredictProviderTimeout, construct: predictor.NewRemoteTabPredictProvider},
		{enabled: config.bqmlBoostedProviderEnabled, timeout: config.bqmlBoostedProviderTimeout, construct: predictor.NewRemoteBQMLBoostedProvider},
	})
	if timelineErr != nil && providerErr == nil {
		providerErr = timelineErr
	}

	checkpointValue := strings.TrimSpace(config.predictionCheckpoints)
	checkpoints := predictor.ParseCheckpoints(checkpointValue)
	if checkpointValue == "" && predictor.Enabled(provider) {
		checkpoints = predictor.DefaultCheckpoints()
	}

	return Options{
		ProjectID:              strings.TrimSpace(config.projectID),
		Port:                   portOrDefault(config.port),
		BigQueryDataset:        strings.TrimSpace(config.bigQueryDataset),
		BigQueryTable:          strings.TrimSpace(config.bigQueryTable),
		BigQueryProcessesTable: strings.TrimSpace(config.bigQueryProcessesTable),
		PredictionProvider:     provider,
		ForecastProvider:       forecastProvider,
		TabPredictProvider:     tabPredictProvider,
		BQMLBoostedProvider:    bqmlBoostedProvider,
		PredictionCheckpoints:  checkpoints,
	}, providerErr
}

// Run initializes backend dependencies and starts the HTTP server.
func Run(ctx context.Context, options Options) error {
	if strings.TrimSpace(options.ProjectID) == "" {
		return errors.New("GOOGLE_CLOUD_PROJECT environment variable is required")
	}

	auth.Initialize()

	bqExporter, err := bigqueryexport.New(ctx, options.ProjectID, options.BigQueryDataset, options.BigQueryTable, options.BigQueryProcessesTable)
	if err != nil {
		log.Printf("⚠️ BigQuery client init failed; continuing without export: %v", err)
		bqExporter = nil
	}
	if bqExporter != nil {
		defer func() {
			if err := bqExporter.Close(); err != nil {
				log.Printf("BigQuery client close: %v", err)
			}
		}()
		log.Printf("📊 BigQuery export enabled: dataset=%q samples=%q processes=%q",
			options.BigQueryDataset, bqSamplesTableOrDefault(options.BigQueryTable), bqProcessesTableOrDefault(options.BigQueryProcessesTable))
	} else {
		log.Printf("📊 BigQuery export disabled (set BIGQUERY_EXPORT_DATASET to enable)")
	}

	storageClient, err := storage.NewClient(ctx, options.ProjectID)
	if err != nil {
		return err
	}
	defer storageClient.Close()

	exportSched := exportqueue.New(bqExporter, storageClient.GetRun, storageClient.GetProcesses)
	provider := providerOrNoop(options.PredictionProvider)
	if len(options.PredictionCheckpoints) == 0 || !predictor.Enabled(provider) {
		log.Printf("🔮 Predictive reliability disabled (set private provider and PREDICTIVE_RELIABILITY_CHECKPOINTS to enable)")
	}

	forecastProvider := options.ForecastProvider
	if forecastProvider == nil {
		forecastProvider = predictor.NoopForecastProvider{}
	}
	if predictor.ForecastEnabled(forecastProvider) {
		log.Printf("🔮 Process forecast provider enabled")
	}
	tabPredictProvider := options.TabPredictProvider
	if tabPredictProvider == nil {
		tabPredictProvider = predictor.NoopForecastProvider{}
	}
	if predictor.ForecastEnabled(tabPredictProvider) {
		log.Printf("🔮 Process tabpredict provider enabled")
	}
	bqmlBoostedProvider := options.BQMLBoostedProvider
	if bqmlBoostedProvider == nil {
		bqmlBoostedProvider = predictor.NoopForecastProvider{}
	}
	if predictor.ForecastEnabled(bqmlBoostedProvider) {
		log.Printf("🔮 Process bqml-boosted provider enabled")
	}
	h := handlers.NewHandlersWithPredictor(storageClient, exportSched, provider, options.PredictionCheckpoints, options.FallbackClassifier, forecastProvider, tabPredictProvider, bqmlBoostedProvider)

	predictionSched, predictionCloser := newPredictionScheduler(ctx, options)
	if predictionCloser != nil {
		defer func() {
			if err := predictionCloser(); err != nil {
				log.Printf("prediction scheduler close: %v", err)
			}
		}()
	}
	h.SetPredictionScheduler(predictionSched, options.PredictionJobToken)

	cleanupService := cleanup.NewService(storageClient, exportSched)
	mux := NewMux(h, cleanupService)
	port := portOrDefault(options.Port)

	log.Printf("🚀 Server starting on port %s", port)
	log.Printf("📊 Monitoring endpoints:")
	log.Printf("   - GET  /healthz")
	log.Printf("   - POST /auth/run/{runId}")
	log.Printf("   - POST /ingest (JWT required)")
	log.Printf("   - POST /internal/prediction-jobs (prediction job token)")
	log.Printf("   - GET  /runs/{runId}")
	log.Printf("   - POST /finish/{runId} (JWT required)")
	log.Printf("   - POST /cleanup/stale (Admin required)")

	return http.ListenAndServe(":"+port, mux)
}

type timelineProviderSpec struct {
	enabled   bool
	timeout   time.Duration
	construct func(predictor.RemoteForecastConfig) (*predictor.RemoteForecastProvider, error)
}

func buildTimelineProviders(base predictor.RemoteForecastConfig, specs []timelineProviderSpec) (forecast, tab, bqml predictor.ForecastProvider, firstErr error) {
	out := make([]predictor.ForecastProvider, len(specs))
	for i := range out {
		out[i] = predictor.NoopForecastProvider{}
	}
	for i, spec := range specs {
		if !spec.enabled {
			continue
		}
		cfg := base
		cfg.Timeout = spec.timeout
		remote, err := spec.construct(cfg)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		out[i] = remote
	}
	for len(out) < 3 {
		out = append(out, predictor.NoopForecastProvider{})
	}
	return out[0], out[1], out[2], firstErr
}

func timelineThrottleModeFromEnv() string {
	if predictionProviderEnabled(firstNonEmpty(os.Getenv("PREDICTIVE_TABPREDICT_PROVIDER_ENABLED"), os.Getenv("PREDICTIVE_PROVIDER_ENABLED"))) {
		return "predict"
	}
	if predictionProviderEnabled(firstNonEmpty(os.Getenv("PREDICTIVE_FORECAST_PROVIDER_ENABLED"), os.Getenv("PREDICTIVE_PROVIDER_ENABLED"))) {
		return "forecast"
	}
	if predictionProviderEnabled(os.Getenv("PREDICTIVE_BQML_BOOSTED_PROVIDER_ENABLED")) {
		return "bqml-boosted"
	}
	return "predict"
}

func newPredictionScheduler(ctx context.Context, options Options) (predictionqueue.Scheduler, func() error) {
	queue := strings.TrimSpace(options.PredictionTasksQueue)
	location := strings.TrimSpace(firstNonEmpty(options.PredictionTasksLocation, "us-central1"))
	targetURL := strings.TrimSpace(options.PredictionJobURL)
	token := strings.TrimSpace(options.PredictionJobToken)
	if queue == "" || targetURL == "" || token == "" {
		log.Printf("🔮 Prediction job queue disabled (set PREDICTION_TASKS_QUEUE, PREDICTION_JOB_URL, PREDICTION_JOB_TOKEN to enable Cloud Tasks offload)")
		return predictionqueue.Noop{}, nil
	}
	mode := strings.TrimSpace(options.PredictionThrottleMode)
	if mode == "" {
		mode = "predict"
	}
	sched, err := predictionqueue.NewCloudTasks(ctx, predictionqueue.CloudTasksConfig{
		ProjectID:    options.ProjectID,
		Location:     location,
		Queue:        queue,
		TargetURL:    targetURL,
		AuthToken:    token,
		ThrottleMode: mode,
	})
	if err != nil {
		log.Printf("🔮 Prediction Cloud Tasks scheduler disabled: %v", err)
		return predictionqueue.Noop{}, nil
	}
	return sched, sched.Close
}

func providerOrNoop(provider predictor.Provider) predictor.Provider {
	if provider == nil {
		return predictor.NoopProvider{}
	}
	return provider
}

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
	mux.HandleFunc("/test", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("Test endpoint working"))
	})
	return mux
}

func portOrDefault(port string) string {
	port = strings.TrimSpace(port)
	if port == "" {
		return "8080"
	}
	return port
}

func bqSamplesTableOrDefault(table string) string {
	if table == "" {
		return "build_process_samples"
	}
	return table
}

func bqProcessesTableOrDefault(table string) string {
	if table == "" {
		return "build_process_processes"
	}
	return table
}

func predictionProviderEnabled(value string) bool {
	enabled, err := strconv.ParseBool(strings.TrimSpace(value))
	return err == nil && enabled
}

func parseRemoteProviderTimeout(value string) time.Duration {
	millis, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || millis <= 0 {
		return 0
	}
	return time.Duration(millis) * time.Millisecond
}

func parseForecastProviderTimeout(value string) time.Duration {
	millis, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || millis <= 0 {
		return 20 * time.Second
	}
	return time.Duration(millis) * time.Millisecond
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
