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
	GetRun(ctx context.Context, runID string) (*models.RunDoc, error)
	AppendProcessForecasts(ctx context.Context, runID string, forecasts []models.ProcessForecast) error
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
	runDoc, err := e.repo.GetRun(ctx, runID)
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
	if err := e.repo.AppendProcessForecasts(ctx, runID, forecasts); err != nil {
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
	maxElapsed := maxSampleElapsedS(samples)
	if maxElapsed < throttleS {
		return false
	}
	bucket := maxElapsed / throttleS
	if len(existing) == 0 {
		return true
	}
	latestIssuanceElapsed := 0
	for _, forecast := range existing {
		elapsed := issuanceElapsedS(samples, forecast.CreatedAtMs)
		if elapsed > latestIssuanceElapsed {
			latestIssuanceElapsed = elapsed
		}
	}
	return bucket > latestIssuanceElapsed/throttleS
}

func maxSampleElapsedS(samples []models.Sample) int {
	maxElapsed := 0
	for _, sample := range samples {
		if sample.ElapsedTime > maxElapsed {
			maxElapsed = sample.ElapsedTime
		}
	}
	return maxElapsed
}

// issuanceElapsedS maps a forecast CreatedAtMs onto run elapsed seconds.
// CreatedAtMs is a sample-clock timestamp (not wall clock); never divide epoch
// millis by 1000 — that yields ~1e9 and permanently suppresses later issuances.
func issuanceElapsedS(samples []models.Sample, createdAtMs int64) int {
	if createdAtMs <= 0 || len(samples) == 0 {
		return 0
	}
	nearestBeforeElapsed := -1
	var nearestBeforeTs int64 = -1
	nearestAnyElapsed := 0
	nearestAnyDelta := int64(-1)
	for _, sample := range samples {
		if sample.Timestamp == createdAtMs {
			return sample.ElapsedTime
		}
		if sample.Timestamp <= createdAtMs && sample.Timestamp >= nearestBeforeTs {
			nearestBeforeTs = sample.Timestamp
			nearestBeforeElapsed = sample.ElapsedTime
		}
		delta := sample.Timestamp - createdAtMs
		if delta < 0 {
			delta = -delta
		}
		if nearestAnyDelta < 0 || delta < nearestAnyDelta {
			nearestAnyDelta = delta
			nearestAnyElapsed = sample.ElapsedTime
		}
	}
	if nearestBeforeElapsed >= 0 {
		return nearestBeforeElapsed
	}
	return nearestAnyElapsed
}
