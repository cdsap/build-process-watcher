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

	// Prediction job queue settings (Cloud Tasks offload from /ingest).
	PredictionTasksQueue    string
	PredictionTasksLocation string
	PredictionJobURL        string
	PredictionJobToken      string
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
	predictionTasksQueue       string
	predictionTasksLocation    string
	predictionJobURL           string
	predictionJobToken         string
}

type timelineProviderSpec struct {
	enabled bool
	timeout time.Duration
	newFn   func(predictor.RemoteForecastConfig) (*predictor.RemoteForecastProvider, error)
	assign  func(*Options, predictor.ForecastProvider)
}

// OptionsFromEnv reads public backend configuration from environment variables.
func OptionsFromEnv() Options {
	providerEnabled := os.Getenv("PREDICTIVE_PROVIDER_ENABLED")
	forecastTimeoutMS := os.Getenv("PREDICTIVE_FORECAST_PROVIDER_TIMEOUT_MS")
	options, err := buildOptions(serverConfig{
		projectID:                  strings.TrimSpace(os.Getenv("GOOGLE_CLOUD_PROJECT")),
		port:                       os.Getenv("PORT"),
		bigQueryDataset:            strings.TrimSpace(os.Getenv("BIGQUERY_EXPORT_DATASET")),
		bigQueryTable:              strings.TrimSpace(os.Getenv("BIGQUERY_EXPORT_TABLE")),
		bigQueryProcessesTable:     strings.TrimSpace(os.Getenv("BIGQUERY_EXPORT_PROCESSES_TABLE")),
		predictionProviderEnabled:  predictionProviderEnabled(providerEnabled),
		predictionProviderURL:      os.Getenv("PREDICTIVE_PROVIDER_URL"),
		predictionProviderAuth:     os.Getenv("PREDICTIVE_PROVIDER_AUTH_AUDIENCE"),
		predictionProviderTime:     parseRemoteProviderTimeout(os.Getenv("PREDICTIVE_PROVIDER_TIMEOUT_MS")),
		predictionCheckpoints:      os.Getenv("PREDICTIVE_RELIABILITY_CHECKPOINTS"),
		forecastProviderEnabled:    predictionProviderEnabled(firstNonEmpty(os.Getenv("PREDICTIVE_FORECAST_PROVIDER_ENABLED"), providerEnabled)),
		forecastProviderTimeout:    parseForecastProviderTimeout(forecastTimeoutMS),
		tabPredictProviderEnabled:  predictionProviderEnabled(firstNonEmpty(os.Getenv("PREDICTIVE_TABPREDICT_PROVIDER_ENABLED"), providerEnabled)),
		tabPredictProviderTimeout:  parseForecastProviderTimeout(firstNonEmpty(os.Getenv("PREDICTIVE_TABPREDICT_PROVIDER_TIMEOUT_MS"), forecastTimeoutMS)),
		bqmlBoostedProviderEnabled: predictionProviderEnabled(firstNonEmpty(os.Getenv("PREDICTIVE_BQML_BOOSTED_PROVIDER_ENABLED"), providerEnabled)),
		bqmlBoostedProviderTimeout: parseForecastProviderTimeout(firstNonEmpty(os.Getenv("PREDICTIVE_BQML_BOOSTED_PROVIDER_TIMEOUT_MS"), forecastTimeoutMS)),
		predictionTasksQueue:       os.Getenv("PREDICTION_TASKS_QUEUE"),
		predictionTasksLocation:    firstNonEmpty(os.Getenv("PREDICTION_TASKS_LOCATION"), "us-central1"),
		predictionJobURL:           os.Getenv("PREDICTION_JOB_URL"),
		predictionJobToken:         os.Getenv("PREDICTION_JOB_TOKEN"),
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

	options := Options{
		ProjectID:               strings.TrimSpace(config.projectID),
		Port:                    portOrDefault(config.port),
		BigQueryDataset:         strings.TrimSpace(config.bigQueryDataset),
		BigQueryTable:           strings.TrimSpace(config.bigQueryTable),
		BigQueryProcessesTable:  strings.TrimSpace(config.bigQueryProcessesTable),
		PredictionProvider:      provider,
		ForecastProvider:        predictor.NoopForecastProvider{},
		TabPredictProvider:      predictor.NoopForecastProvider{},
		BQMLBoostedProvider:     predictor.NoopForecastProvider{},
		PredictionTasksQueue:    strings.TrimSpace(config.predictionTasksQueue),
		PredictionTasksLocation: strings.TrimSpace(config.predictionTasksLocation),
		PredictionJobURL:        strings.TrimSpace(config.predictionJobURL),
		PredictionJobToken:      strings.TrimSpace(config.predictionJobToken),
	}

	remoteCfg := predictor.RemoteForecastConfig{
		URL:          config.predictionProviderURL,
		AuthAudience: config.predictionProviderAuth,
	}
	for _, spec := range timelineProviderSpecs(config) {
		if !spec.enabled {
			continue
		}
		cfg := remoteCfg
		cfg.Timeout = spec.timeout
		remote, err := spec.newFn(cfg)
		if err != nil {
			if providerErr == nil {
				providerErr = err
			}
			spec.assign(&options, predictor.NoopForecastProvider{})
			continue
		}
		spec.assign(&options, remote)
	}

	checkpointValue := strings.TrimSpace(config.predictionCheckpoints)
	checkpoints := predictor.ParseCheckpoints(checkpointValue)
	if checkpointValue == "" && predictor.Enabled(provider) {
		checkpoints = predictor.DefaultCheckpoints()
	}
	options.PredictionCheckpoints = checkpoints

	return options, providerErr
}

func timelineProviderSpecs(config serverConfig) []timelineProviderSpec {
	// One constructor entry per timeline PredictionMode (forecast / predict / bqml-boosted).
	return []timelineProviderSpec{
		{
			enabled: config.forecastProviderEnabled,
			timeout: config.forecastProviderTimeout,
			newFn:   predictor.NewRemoteForecastProvider,
			assign:  func(o *Options, p predictor.ForecastProvider) { o.ForecastProvider = p },
		},
		{
			enabled: config.tabPredictProviderEnabled,
			timeout: config.tabPredictProviderTimeout,
			newFn:   predictor.NewRemoteTabPredictProvider,
			assign:  func(o *Options, p predictor.ForecastProvider) { o.TabPredictProvider = p },
		},
		{
			enabled: config.bqmlBoostedProviderEnabled,
			timeout: config.bqmlBoostedProviderTimeout,
			newFn:   predictor.NewRemoteBQMLBoostedProvider,
			assign:  func(o *Options, p predictor.ForecastProvider) { o.BQMLBoostedProvider = p },
		},
	}
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

	exportSched := exportqueue.New(bqExporter, storageClient.GetRunWithContext, storageClient.GetProcessesWithContext)
	provider := providerOrNoop(options.PredictionProvider)
	if len(options.PredictionCheckpoints) == 0 || !predictor.Enabled(provider) {
		log.Printf("🔮 Predictive reliability disabled (set private provider and PREDICTIVE_RELIABILITY_CHECKPOINTS to enable)")
	}

	forecastProvider := forecastProviderOrNoop(options.ForecastProvider)
	if predictor.ForecastEnabled(forecastProvider) {
		log.Printf("🔮 Process forecast provider enabled")
	}
	tabPredictProvider := forecastProviderOrNoop(options.TabPredictProvider)
	if predictor.ForecastEnabled(tabPredictProvider) {
		log.Printf("🔮 Process tabpredict provider enabled")
	}
	bqmlBoostedProvider := forecastProviderOrNoop(options.BQMLBoostedProvider)
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

func newPredictionScheduler(ctx context.Context, options Options) (predictionqueue.Scheduler, func() error) {
	queue := strings.TrimSpace(options.PredictionTasksQueue)
	location := strings.TrimSpace(firstNonEmpty(options.PredictionTasksLocation, "us-central1"))
	targetURL := strings.TrimSpace(options.PredictionJobURL)
	token := strings.TrimSpace(options.PredictionJobToken)
	if queue == "" || targetURL == "" || token == "" {
		log.Printf("🔮 Prediction job queue disabled (set PREDICTION_TASKS_QUEUE, PREDICTION_JOB_URL, PREDICTION_JOB_TOKEN to enable Cloud Tasks offload)")
		return predictionqueue.Noop{}, nil
	}
	sched, err := predictionqueue.NewCloudTasks(ctx, predictionqueue.CloudTasksConfig{
		ProjectID: options.ProjectID,
		Location:  location,
		Queue:     queue,
		TargetURL: targetURL,
		AuthToken: token,
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

func forecastProviderOrNoop(provider predictor.ForecastProvider) predictor.ForecastProvider {
	if provider == nil {
		return predictor.NoopForecastProvider{}
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
