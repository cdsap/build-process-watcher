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
	PredictionCheckpoints  []int
	// FallbackClassifier maps provider failures onto public-safe telemetry.
	// Composition roots (for example backend main) supply provider-specific
	// sentinel mapping; nil uses predictor.DefaultFallbackClassifier.
	FallbackClassifier predictor.FallbackClassifier
}

type serverConfig struct {
	projectID                   string
	port                        string
	bigQueryDataset             string
	bigQueryTable               string
	bigQueryProcessesTable      string
	predictionProviderEnabled   bool
	predictionProviderURL       string
	predictionProviderAuth      string
	predictionProviderTime      time.Duration
	predictionCheckpoints       string
	forecastProviderEnabled     bool
	forecastProviderTimeout     time.Duration
	tabPredictProviderEnabled   bool
	tabPredictProviderTimeout   time.Duration
}

// OptionsFromEnv reads public backend configuration from environment variables.
func OptionsFromEnv() Options {
	options, err := buildOptions(serverConfig{
		projectID:                 strings.TrimSpace(os.Getenv("GOOGLE_CLOUD_PROJECT")),
		port:                      os.Getenv("PORT"),
		bigQueryDataset:           strings.TrimSpace(os.Getenv("BIGQUERY_EXPORT_DATASET")),
		bigQueryTable:             strings.TrimSpace(os.Getenv("BIGQUERY_EXPORT_TABLE")),
		bigQueryProcessesTable:    strings.TrimSpace(os.Getenv("BIGQUERY_EXPORT_PROCESSES_TABLE")),
		predictionProviderEnabled: predictionProviderEnabled(os.Getenv("PREDICTIVE_PROVIDER_ENABLED")),
		predictionProviderURL:     os.Getenv("PREDICTIVE_PROVIDER_URL"),
		predictionProviderAuth:    os.Getenv("PREDICTIVE_PROVIDER_AUTH_AUDIENCE"),
		predictionProviderTime:    parseRemoteProviderTimeout(os.Getenv("PREDICTIVE_PROVIDER_TIMEOUT_MS")),
		predictionCheckpoints:     os.Getenv("PREDICTIVE_RELIABILITY_CHECKPOINTS"),
		forecastProviderEnabled:   predictionProviderEnabled(firstNonEmpty(os.Getenv("PREDICTIVE_FORECAST_PROVIDER_ENABLED"), os.Getenv("PREDICTIVE_PROVIDER_ENABLED"))),
		forecastProviderTimeout:   parseForecastProviderTimeout(os.Getenv("PREDICTIVE_FORECAST_PROVIDER_TIMEOUT_MS")),
		tabPredictProviderEnabled: predictionProviderEnabled(firstNonEmpty(os.Getenv("PREDICTIVE_TABPREDICT_PROVIDER_ENABLED"), os.Getenv("PREDICTIVE_PROVIDER_ENABLED"))),
		tabPredictProviderTimeout: parseForecastProviderTimeout(firstNonEmpty(os.Getenv("PREDICTIVE_TABPREDICT_PROVIDER_TIMEOUT_MS"), os.Getenv("PREDICTIVE_FORECAST_PROVIDER_TIMEOUT_MS"))),
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

	exportSched := exportqueue.New(bqExporter, storageClient.GetRunWithContext, storageClient.GetProcessesWithContext)
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
	h := handlers.NewHandlersWithPredictor(storageClient, exportSched, provider, options.PredictionCheckpoints, options.FallbackClassifier, forecastProvider, tabPredictProvider)

	predictionSched, predictionCloser := newPredictionScheduler(ctx, options.ProjectID)
	if predictionCloser != nil {
		defer func() {
			if err := predictionCloser(); err != nil {
				log.Printf("prediction scheduler close: %v", err)
			}
		}()
	}
	h.SetPredictionScheduler(predictionSched, strings.TrimSpace(os.Getenv("PREDICTION_JOB_TOKEN")))

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
