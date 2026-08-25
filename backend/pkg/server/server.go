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
	PredictionCheckpoints  []int
	// FallbackClassifier maps provider failures onto public-safe telemetry.
	// Composition roots (for example backend main) supply provider-specific
	// sentinel mapping; nil uses predictor.DefaultFallbackClassifier.
	FallbackClassifier predictor.FallbackClassifier
}

// OptionsFromEnv reads public backend configuration from environment variables.
func OptionsFromEnv() Options {
	predictionProvider := predictor.Provider(predictor.NoopProvider{})
	if predictionProviderEnabled(os.Getenv("PREDICTIVE_PROVIDER_ENABLED")) {
		if remoteProvider, err := predictor.NewRemoteProvider(predictor.RemoteConfig{
			URL:          os.Getenv("PREDICTIVE_PROVIDER_URL"),
			Timeout:      parseRemoteProviderTimeout(os.Getenv("PREDICTIVE_PROVIDER_TIMEOUT_MS")),
			AuthAudience: os.Getenv("PREDICTIVE_PROVIDER_AUTH_AUDIENCE"),
		}); err == nil {
			predictionProvider = remoteProvider
		} else {
			log.Printf("🔮 Remote predictive provider disabled: %v", err)
		}
	}
	predictionCheckpointsValue := strings.TrimSpace(os.Getenv("PREDICTIVE_RELIABILITY_CHECKPOINTS"))
	predictionCheckpoints := predictor.ParseCheckpoints(predictionCheckpointsValue)
	if predictionCheckpointsValue == "" && predictor.Enabled(predictionProvider) {
		predictionCheckpoints = predictor.DefaultCheckpoints()
	}

	return Options{
		ProjectID:              strings.TrimSpace(os.Getenv("GOOGLE_CLOUD_PROJECT")),
		Port:                   portOrDefault(os.Getenv("PORT")),
		BigQueryDataset:        strings.TrimSpace(os.Getenv("BIGQUERY_EXPORT_DATASET")),
		BigQueryTable:          strings.TrimSpace(os.Getenv("BIGQUERY_EXPORT_TABLE")),
		BigQueryProcessesTable: strings.TrimSpace(os.Getenv("BIGQUERY_EXPORT_PROCESSES_TABLE")),
		PredictionProvider:     predictionProvider,
		PredictionCheckpoints:  predictionCheckpoints,
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
	provider := options.PredictionProvider
	if provider == nil {
		provider = predictor.NoopProvider{}
	}
	if len(options.PredictionCheckpoints) == 0 || !predictor.Enabled(provider) {
		log.Printf("🔮 Predictive reliability disabled (set private provider and PREDICTIVE_RELIABILITY_CHECKPOINTS to enable)")
	}

	h := handlers.NewHandlersWithPredictor(storageClient, exportSched, provider, options.PredictionCheckpoints, options.FallbackClassifier)
	cleanupService := cleanup.NewService(storageClient, exportSched)
	mux := NewMux(h, cleanupService)
	port := portOrDefault(options.Port)

	log.Printf("🚀 Server starting on port %s", port)
	log.Printf("📊 Monitoring endpoints:")
	log.Printf("   - GET  /healthz")
	log.Printf("   - POST /auth/run/{runId}")
	log.Printf("   - POST /ingest (JWT required)")
	log.Printf("   - GET  /runs/{runId}")
	log.Printf("   - POST /finish/{runId} (JWT required)")
	log.Printf("   - POST /cleanup/stale (Admin required)")

	return http.ListenAndServe(":"+port, mux)
}

// NewMux registers backend routes on a new ServeMux.
func NewMux(h *handlers.Handlers, cleanupService *cleanup.Service) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", h.Health)
	mux.HandleFunc("/auth/run/", h.Auth)
	mux.HandleFunc("/ingest", h.Ingest)
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
