package server

import (
	"context"
	"errors"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
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

const (
	readHeaderTimeout = 10 * time.Second
	readTimeout       = 30 * time.Second
	writeTimeout      = 60 * time.Second
	idleTimeout       = 120 * time.Second
	shutdownTimeout   = 10 * time.Second
)

// monitoredEndpoints is the public route inventory used for startup logs and
// mux registration tests. Keep descriptions and probe paths aligned with NewMux.
var monitoredEndpoints = []struct {
	description string
	probePath   string
}{
	{description: "GET  /healthz", probePath: "/healthz"},
	{description: "POST /auth/run/{runId}", probePath: "/auth/run/run-1"},
	{description: "POST /ingest (JWT required)", probePath: "/ingest"},
	{description: "POST /internal/prediction-jobs (prediction job token)", probePath: "/internal/prediction-jobs"},
	{description: "GET  /runs/{runId}", probePath: "/runs/run-1"},
	{description: "POST /finish/{runId} (JWT required)", probePath: "/finish/run-1"},
	{description: "POST /cleanup/stale (Admin required)", probePath: "/cleanup/stale"},
}

// Deps holds injectable client factories for Build. Nil fields use production constructors.
type Deps struct {
	NewBigQueryExporter    func(ctx context.Context, projectID, dataset, samplesTable, processesTable string) (*bigqueryexport.Exporter, error)
	NewStorageClient       func(ctx context.Context, projectID string) (*storage.Client, error)
	NewPredictionScheduler func(ctx context.Context, projectID string) (predictionqueue.Scheduler, func() error)
}

// App is a constructed backend HTTP server with closable dependencies.
type App struct {
	Server  *http.Server
	closers []func() error

	mu   sync.Mutex
	addr string
}

// Addr returns the bound listen address once Serve has started, or empty otherwise.
func (a *App) Addr() string {
	if a == nil {
		return ""
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.addr
}

func (a *App) setAddr(addr string) {
	a.mu.Lock()
	a.addr = addr
	a.mu.Unlock()
}

func (a *App) close() {
	for i := len(a.closers) - 1; i >= 0; i-- {
		if a.closers[i] == nil {
			continue
		}
		if err := a.closers[i](); err != nil {
			log.Printf("server resource close: %v", err)
		}
	}
}

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

	forecastProvider := predictor.ForecastProvider(predictor.NoopForecastProvider{})
	if config.forecastProviderEnabled {
		remoteForecast, forecastErr := predictor.NewRemoteForecastProvider(predictor.RemoteForecastConfig{
			URL:          config.predictionProviderURL,
			Timeout:      config.forecastProviderTimeout,
			AuthAudience: config.predictionProviderAuth,
		})
		if forecastErr != nil {
			if providerErr == nil {
				providerErr = forecastErr
			}
			forecastProvider = predictor.NoopForecastProvider{}
		} else {
			forecastProvider = remoteForecast
		}
	}

	tabPredictProvider := predictor.ForecastProvider(predictor.NoopForecastProvider{})
	if config.tabPredictProviderEnabled {
		remoteTab, tabErr := predictor.NewRemoteTabPredictProvider(predictor.RemoteForecastConfig{
			URL:          config.predictionProviderURL,
			Timeout:      config.tabPredictProviderTimeout,
			AuthAudience: config.predictionProviderAuth,
		})
		if tabErr != nil {
			if providerErr == nil {
				providerErr = tabErr
			}
			tabPredictProvider = predictor.NoopForecastProvider{}
		} else {
			tabPredictProvider = remoteTab
		}
	}

	bqmlBoostedProvider := predictor.ForecastProvider(predictor.NoopForecastProvider{})
	if config.bqmlBoostedProviderEnabled {
		remoteBoosted, boostedErr := predictor.NewRemoteBQMLBoostedProvider(predictor.RemoteForecastConfig{
			URL:          config.predictionProviderURL,
			Timeout:      config.bqmlBoostedProviderTimeout,
			AuthAudience: config.predictionProviderAuth,
		})
		if boostedErr != nil {
			if providerErr == nil {
				providerErr = boostedErr
			}
			bqmlBoostedProvider = predictor.NoopForecastProvider{}
		} else {
			bqmlBoostedProvider = remoteBoosted
		}
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

// Run builds the backend with production dependencies and serves until ctx is cancelled.
func Run(ctx context.Context, options Options) error {
	app, err := Build(ctx, options, Deps{})
	if err != nil {
		return err
	}
	return app.Serve(ctx)
}

// Build wires backend dependencies and returns an App ready to Serve.
func Build(ctx context.Context, options Options, deps Deps) (*App, error) {
	if strings.TrimSpace(options.ProjectID) == "" {
		return nil, errors.New("GOOGLE_CLOUD_PROJECT environment variable is required")
	}

	auth.Initialize()

	newBQ := deps.NewBigQueryExporter
	if newBQ == nil {
		newBQ = bigqueryexport.New
	}
	newStorage := deps.NewStorageClient
	if newStorage == nil {
		newStorage = storage.NewClient
	}
	newPrediction := deps.NewPredictionScheduler
	if newPrediction == nil {
		newPrediction = newPredictionScheduler
	}

	app := &App{}

	bqExporter, err := newBQ(ctx, options.ProjectID, options.BigQueryDataset, options.BigQueryTable, options.BigQueryProcessesTable)
	if err != nil {
		log.Printf("⚠️ BigQuery client init failed; continuing without export: %v", err)
		bqExporter = nil
	}
	if bqExporter != nil {
		app.closers = append(app.closers, bqExporter.Close)
		log.Printf("📊 BigQuery export enabled: dataset=%q samples=%q processes=%q",
			options.BigQueryDataset, bqSamplesTableOrDefault(options.BigQueryTable), bqProcessesTableOrDefault(options.BigQueryProcessesTable))
	} else {
		log.Printf("📊 BigQuery export disabled (set BIGQUERY_EXPORT_DATASET to enable)")
	}

	storageClient, err := newStorage(ctx, options.ProjectID)
	if err != nil {
		app.close()
		return nil, err
	}
	if storageClient != nil {
		app.closers = append(app.closers, storageClient.Close)
	}

	var getRun exportqueue.RunGetter
	var getProcesses exportqueue.ProcessGetter
	if storageClient != nil {
		getRun = storageClient.GetRunWithContext
		getProcesses = storageClient.GetProcessesWithContext
	}
	exportSched := exportqueue.New(bqExporter, getRun, getProcesses)
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

	predictionSched, predictionCloser := newPrediction(ctx, options.ProjectID)
	if predictionCloser != nil {
		app.closers = append(app.closers, predictionCloser)
	}
	h.SetPredictionScheduler(predictionSched, strings.TrimSpace(os.Getenv("PREDICTION_JOB_TOKEN")))

	cleanupService := cleanup.NewService(storageClient, exportSched)
	mux := NewMux(h, cleanupService)
	port := portOrDefault(options.Port)

	app.Server = &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: readHeaderTimeout,
		ReadTimeout:       readTimeout,
		WriteTimeout:      writeTimeout,
		IdleTimeout:       idleTimeout,
	}
	return app, nil
}

// Serve starts the HTTP server and shuts it down when ctx is cancelled so dependency closers run.
func (a *App) Serve(ctx context.Context) error {
	if a == nil || a.Server == nil {
		return errors.New("server: App is not built")
	}
	defer a.close()

	ln, err := net.Listen("tcp", a.Server.Addr)
	if err != nil {
		return err
	}
	a.setAddr(ln.Addr().String())

	log.Printf("🚀 Server starting on %s", a.Addr())
	log.Printf("📊 Monitoring endpoints:")
	for _, endpoint := range monitoredEndpoints {
		log.Printf("   - %s", endpoint.description)
	}

	errCh := make(chan error, 1)
	go func() {
		serveErr := a.Server.Serve(ln)
		if serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			errCh <- serveErr
			return
		}
		errCh <- nil
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		if shutdownErr := a.Server.Shutdown(shutdownCtx); shutdownErr != nil {
			_ = a.Server.Close()
			<-errCh
			return shutdownErr
		}
		if serveErr := <-errCh; serveErr != nil {
			return serveErr
		}
		return nil
	case serveErr := <-errCh:
		return serveErr
	}
}

func newPredictionScheduler(ctx context.Context, projectID string) (predictionqueue.Scheduler, func() error) {
	queue := strings.TrimSpace(os.Getenv("PREDICTION_TASKS_QUEUE"))
	location := strings.TrimSpace(firstNonEmpty(os.Getenv("PREDICTION_TASKS_LOCATION"), "us-central1"))
	targetURL := strings.TrimSpace(os.Getenv("PREDICTION_JOB_URL"))
	token := strings.TrimSpace(os.Getenv("PREDICTION_JOB_TOKEN"))
	if queue == "" || targetURL == "" || token == "" {
		log.Printf("🔮 Prediction job queue disabled (set PREDICTION_TASKS_QUEUE, PREDICTION_JOB_URL, PREDICTION_JOB_TOKEN to enable Cloud Tasks offload)")
		return predictionqueue.Noop{}, nil
	}
	mode := "predict"
	if predictionProviderEnabled(firstNonEmpty(os.Getenv("PREDICTIVE_TABPREDICT_PROVIDER_ENABLED"), os.Getenv("PREDICTIVE_PROVIDER_ENABLED"))) {
		mode = "predict"
	} else if predictionProviderEnabled(firstNonEmpty(os.Getenv("PREDICTIVE_FORECAST_PROVIDER_ENABLED"), os.Getenv("PREDICTIVE_PROVIDER_ENABLED"))) {
		mode = "forecast"
	} else if predictionProviderEnabled(os.Getenv("PREDICTIVE_BQML_BOOSTED_PROVIDER_ENABLED")) {
		mode = "bqml-boosted"
	}
	sched, err := predictionqueue.NewCloudTasks(ctx, predictionqueue.CloudTasksConfig{
		ProjectID:    projectID,
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
