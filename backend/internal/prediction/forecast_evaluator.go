package prediction

import (
	"context"
	"log"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/models"
	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
)

// Predict mode targets a denser continuous tracking chart; forecast mode stays coarser.
const forecastThrottleElapsedS = 30
const predictThrottleElapsedS = 20

// ForecastRepository is the persistence surface used by forecast evaluation.
type ForecastRepository interface {
	GetRun(runID string) (*models.RunDoc, error)
	AppendProcessForecasts(runID string, forecasts []models.ProcessForecast) error
}

// ForecastEvaluator coordinates process-forecast provider calls after ingest.
// prediction_mode=forecast uses TimesFM (/forecast); prediction_mode=predict uses TabFM (/tabpredict).
// Both write the same public process_forecasts contract.
type ForecastEvaluator struct {
	repo               ForecastRepository
	forecastProvider   predictor.ForecastProvider
	tabPredictProvider predictor.ForecastProvider
}

// NewForecastEvaluator constructs a forecast evaluator.
func NewForecastEvaluator(repo ForecastRepository, forecastProvider predictor.ForecastProvider) *ForecastEvaluator {
	return NewForecastEvaluatorWithTabPredict(repo, forecastProvider, predictor.NoopForecastProvider{})
}

// NewForecastEvaluatorWithTabPredict constructs an evaluator for forecast and predict modes.
func NewForecastEvaluatorWithTabPredict(repo ForecastRepository, forecastProvider, tabPredictProvider predictor.ForecastProvider) *ForecastEvaluator {
	if forecastProvider == nil {
		forecastProvider = predictor.NoopForecastProvider{}
	}
	if tabPredictProvider == nil {
		tabPredictProvider = predictor.NoopForecastProvider{}
	}
	return &ForecastEvaluator{
		repo:               repo,
		forecastProvider:   forecastProvider,
		tabPredictProvider: tabPredictProvider,
	}
}

// Evaluate requests process forecasts when prediction_mode is forecast or predict.
func (e *ForecastEvaluator) Evaluate(ctx context.Context, runID string) {
	if e == nil || e.repo == nil {
		return
	}
	runDoc, err := e.repo.GetRun(runID)
	if err != nil {
		log.Printf("Forecast skipped: could not load run %s: %v", runID, err)
		return
	}
	if runDoc.Finished {
		return
	}
	mode := normalizeMode(runDoc.PredictionMode)
	provider := e.providerForMode(mode)
	if provider == nil || !predictor.ForecastEnabled(provider) {
		return
	}
	if !shouldForecast(runDoc.Samples, runDoc.ProcessForecasts, throttleForMode(mode)) {
		return
	}

	forecasts, err := provider.Forecast(ctx, predictor.RunSnapshot{
		RunID:   runID,
		Samples: runDoc.Samples,
		Now:     time.Now(),
	})
	if err != nil {
		log.Printf("%s provider failed for run %s: %v", mode, runID, err)
		return
	}
	if len(forecasts) == 0 {
		return
	}
	if err := e.repo.AppendProcessForecasts(runID, forecasts); err != nil {
		log.Printf("%s store failed for run %s: %v", mode, runID, err)
	}
}

func (e *ForecastEvaluator) providerForMode(mode string) predictor.ForecastProvider {
	switch mode {
	case "forecast":
		return e.forecastProvider
	case "predict":
		return e.tabPredictProvider
	default:
		return nil
	}
}

func normalizeMode(mode string) string {
	switch mode {
	case "forecast", "predict", "reliability", "disabled":
		return mode
	default:
		return ""
	}
}

func throttleForMode(mode string) int {
	if mode == "predict" {
		return predictThrottleElapsedS
	}
	return forecastThrottleElapsedS
}

func shouldForecast(samples []models.Sample, existing []models.ProcessForecast, throttleS int) bool {
	if throttleS <= 0 {
		throttleS = forecastThrottleElapsedS
	}
	maxElapsed := 0
	for _, sample := range samples {
		if sample.ElapsedTime > maxElapsed {
			maxElapsed = sample.ElapsedTime
		}
	}
	if maxElapsed < throttleS {
		return false
	}
	bucket := maxElapsed / throttleS
	latestCreated := int64(0)
	for _, forecast := range existing {
		if forecast.CreatedAtMs > latestCreated {
			latestCreated = forecast.CreatedAtMs
		}
	}
	if latestCreated == 0 {
		return true
	}
	// Approximate prior bucket from latest issuance created_at on sample clock.
	latestElapsedGuess := int(latestCreated / 1000)
	for _, sample := range samples {
		if sample.Timestamp == latestCreated {
			latestElapsedGuess = sample.ElapsedTime
			break
		}
	}
	return bucket > latestElapsedGuess/throttleS
}
