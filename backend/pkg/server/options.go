package server

import (
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/bigqueryexport"
	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
)

// Options configures the public backend server composition.
type Options struct {
	ProjectID              string
	Port                   string
	BigQueryDataset        string
	BigQueryTable          string
	BigQueryProcessesTable string
	ForecastProvider       predictor.ForecastProvider
	TabPredictProvider     predictor.ForecastProvider
	BQMLBoostedProvider    predictor.ForecastProvider
	// Prediction job queue (Cloud Tasks). Empty values disable the scheduler.
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
	predictionProviderURL      string
	predictionProviderAuth     string
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
		predictionProviderURL:      os.Getenv("PREDICTIVE_PROVIDER_URL"),
		predictionProviderAuth:     os.Getenv("PREDICTIVE_PROVIDER_AUTH_AUDIENCE"),
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
	return options
}

func buildOptions(config serverConfig) (Options, error) {
	baseRemote := predictor.RemoteForecastConfig{
		URL:          config.predictionProviderURL,
		AuthAudience: config.predictionProviderAuth,
	}
	forecastProvider, tabPredictProvider, bqmlBoostedProvider, timelineErr := buildTimelineProviders(baseRemote, []timelineProviderSpec{
		{enabled: config.forecastProviderEnabled, timeout: config.forecastProviderTimeout, construct: predictor.NewRemoteForecastProvider},
		{enabled: config.tabPredictProviderEnabled, timeout: config.tabPredictProviderTimeout, construct: predictor.NewRemoteTabPredictProvider},
		{enabled: config.bqmlBoostedProviderEnabled, timeout: config.bqmlBoostedProviderTimeout, construct: predictor.NewRemoteBQMLBoostedProvider},
	})

	return Options{
		ProjectID:              strings.TrimSpace(config.projectID),
		Port:                   portOrDefault(config.port),
		BigQueryDataset:        strings.TrimSpace(config.bigQueryDataset),
		BigQueryTable:          strings.TrimSpace(config.bigQueryTable),
		BigQueryProcessesTable: strings.TrimSpace(config.bigQueryProcessesTable),
		ForecastProvider:       forecastProvider,
		TabPredictProvider:     tabPredictProvider,
		BQMLBoostedProvider:    bqmlBoostedProvider,
	}, timelineErr
}

func portOrDefault(port string) string {
	port = strings.TrimSpace(port)
	if port == "" {
		return "8080"
	}
	return port
}

func bqSamplesTableOrDefault(table string) string {
	return bigqueryexport.SamplesTableOrDefault(table)
}

func bqProcessesTableOrDefault(table string) string {
	return bigqueryexport.ProcessesTableOrDefault(table)
}

func predictionProviderEnabled(value string) bool {
	enabled, err := strconv.ParseBool(strings.TrimSpace(value))
	return err == nil && enabled
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
