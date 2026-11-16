package server

import (
	"context"
	"errors"
	"log"
	"net/http"
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
