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
	"github.com/cdsap/build-process-watcher/backend/internal/prediction"
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

// Deps injects optional client factories for tests. Nil fields use production constructors.
type Deps struct {
	NewStorage             func(ctx context.Context, projectID string) (*storage.Client, error)
	NewBigQuery            func(ctx context.Context, projectID, dataset, samplesTable, processesTable string) (*bigqueryexport.Exporter, error)
	NewPredictionScheduler func(ctx context.Context, options Options) (predictionqueue.Scheduler, func() error)
}

// App is a constructed backend HTTP server with closable dependencies.
type App struct {
	Server  *http.Server
	closers []func() error
}

// Build wires dependencies and returns an App ready to Serve. It does not listen.
func Build(ctx context.Context, options Options, deps Deps) (*App, error) {
	if strings.TrimSpace(options.ProjectID) == "" {
		return nil, errors.New("GOOGLE_CLOUD_PROJECT environment variable is required")
	}

	authenticator, err := auth.NewFromEnv()
	if err != nil {
		return nil, err
	}

	newBQ := deps.NewBigQuery
	if newBQ == nil {
		newBQ = bigqueryexport.New
	}
	bqExporter, err := newBQ(ctx, options.ProjectID, options.BigQueryDataset, options.BigQueryTable, options.BigQueryProcessesTable)
	if err != nil {
		log.Printf("⚠️ BigQuery client init failed; continuing without export: %v", err)
		bqExporter = nil
	}

	var closers []func() error
	if bqExporter != nil {
		closers = append(closers, bqExporter.Close)
		log.Printf("📊 BigQuery export enabled: dataset=%q samples=%q processes=%q",
			options.BigQueryDataset, bqSamplesTableOrDefault(options.BigQueryTable), bqProcessesTableOrDefault(options.BigQueryProcessesTable))
	} else {
		log.Printf("📊 BigQuery export disabled (set BIGQUERY_EXPORT_DATASET to enable)")
	}

	newStorage := deps.NewStorage
	if newStorage == nil {
		newStorage = storage.NewClient
	}
	storageClient, err := newStorage(ctx, options.ProjectID)
	if err != nil {
		return nil, err
	}
	closers = append(closers, storageClient.Close)

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
	newSched := deps.NewPredictionScheduler
	if newSched == nil {
		newSched = newPredictionScheduler
	}
	predictionSched, predictionCloser := newSched(ctx, options)
	if predictionCloser != nil {
		closers = append(closers, predictionCloser)
	}
	h := handlers.New(handlers.Config{
		Storage:             storageClient,
		Export:              exportSched,
		ReliabilityProvider: provider,
		Checkpoints:         options.PredictionCheckpoints,
		FallbackClassifier:  options.FallbackClassifier,
		TimelineProviders: prediction.TimelineProviders{
			Forecast:    forecastProvider,
			TabPredict:  tabPredictProvider,
			BQMLBoosted: bqmlBoostedProvider,
		},
		Authenticator:       authenticator,
		PredictionScheduler: predictionSched,
		PredictionJobToken:  options.PredictionJobToken,
	})

	cleanupService := cleanup.NewService(storageClient, exportSched, authenticator)
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

	return &App{
		Server: &http.Server{
			Addr:         ":" + port,
			Handler:      mux,
			ReadTimeout:  30 * time.Second,
			WriteTimeout: 120 * time.Second,
			IdleTimeout:  90 * time.Second,
		},
		closers: closers,
	}, nil
}

// Serve listens until ctx is cancelled, then gracefully shuts down.
func (a *App) Serve(ctx context.Context) error {
	if a == nil || a.Server == nil {
		return errors.New("server app not built")
	}
	errCh := make(chan error, 1)
	go func() {
		errCh <- a.Server.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := a.Server.Shutdown(shutdownCtx); err != nil {
			log.Printf("server shutdown: %v", err)
		}
		a.close()
		if err := <-errCh; err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	case err := <-errCh:
		a.close()
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

func (a *App) close() {
	for i := len(a.closers) - 1; i >= 0; i-- {
		if a.closers[i] == nil {
			continue
		}
		if err := a.closers[i](); err != nil {
			log.Printf("dependency close: %v", err)
		}
	}
}

// Run initializes backend dependencies and starts the HTTP server until ctx ends.
func Run(ctx context.Context, options Options) error {
	app, err := Build(ctx, options, Deps{})
	if err != nil {
		return err
	}
	return app.Serve(ctx)
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
