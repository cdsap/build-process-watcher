package prediction

import (
	"context"
	"log"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/models"
	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
)

// Shared cadence for timeline modes (forecast / predict / bqml-boosted).
const processForecastThrottleElapsedS = 20

// ForecastRepository is the persistence surface used by forecast evaluation.
type ForecastRepository interface {
	GetRun(runID string) (*models.RunDoc, error)
	AppendProcessForecasts(runID string, forecasts []models.ProcessForecast) error
}

// ForecastEvaluator coordinates process-forecast provider calls after ingest.
// prediction_mode=forecast → TimesFM (/forecast)
// prediction_mode=predict → TabFM (/tabpredict)
// prediction_mode=bqml-boosted → trained BQML boosted trees (/bqml-boosted)
// All write the same public process_forecasts contract.
type ForecastEvaluator struct {
	repo                ForecastRepository
	forecastProvider    predictor.ForecastProvider
	tabPredictProvider  predictor.ForecastProvider
	bqmlBoostedProvider predictor.ForecastProvider
}

// NewForecastEvaluator constructs a forecast evaluator.
func NewForecastEvaluator(repo ForecastRepository, forecastProvider predictor.ForecastProvider) *ForecastEvaluator {
	return NewForecastEvaluatorWithProviders(repo, forecastProvider, predictor.NoopForecastProvider{}, predictor.NoopForecastProvider{})
}

// NewForecastEvaluatorWithTabPredict constructs an evaluator for forecast and predict modes.
func NewForecastEvaluatorWithTabPredict(repo ForecastRepository, forecastProvider, tabPredictProvider predictor.ForecastProvider) *ForecastEvaluator {
	return NewForecastEvaluatorWithProviders(repo, forecastProvider, tabPredictProvider, predictor.NoopForecastProvider{})
}

// NewForecastEvaluatorWithProviders constructs an evaluator for all timeline modes.
func NewForecastEvaluatorWithProviders(repo ForecastRepository, forecastProvider, tabPredictProvider, bqmlBoostedProvider predictor.ForecastProvider) *ForecastEvaluator {
	if forecastProvider == nil {
		forecastProvider = predictor.NoopForecastProvider{}
	}
	if tabPredictProvider == nil {
		tabPredictProvider = predictor.NoopForecastProvider{}
	}
	if bqmlBoostedProvider == nil {
		bqmlBoostedProvider = predictor.NoopForecastProvider{}
	}
	return &ForecastEvaluator{
		repo:                repo,
		forecastProvider:    forecastProvider,
		tabPredictProvider:  tabPredictProvider,
		bqmlBoostedProvider: bqmlBoostedProvider,
	}
}

// Evaluate requests process forecasts for forecast, predict, or bqml-boosted modes.
func (e *ForecastEvaluator) Evaluate(ctx context.Context, runID string) {
	if e == nil || e.repo == nil {
		return
	}
	runDoc, err := e.repo.GetRun(runID)
	if err != nil {
		log.Printf("Forecast skipped: could not load run %s: %v", runID, err)
		return
	}
	// Do not skip when Finished: prediction jobs are enqueued from /ingest and may
	// run after /finish. Throttle + AppendProcessForecasts idempotency prevent storms.
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
	case "bqml-boosted":
		return e.bqmlBoostedProvider
	default:
		return nil
	}
}

func normalizeMode(mode string) string {
	switch mode {
	case "forecast", "predict", "bqml-boosted", "reliability", "disabled":
		return mode
	default:
		return ""
	}
}

func throttleForMode(string) int {
	return processForecastThrottleElapsedS
}

func shouldForecast(samples []models.Sample, existing []models.ProcessForecast, throttleS int) bool {
	if throttleS <= 0 {
		throttleS = processForecastThrottleElapsedS
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
