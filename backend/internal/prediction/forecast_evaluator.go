package prediction

import (
	"context"
	"log"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/models"
	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
)

// ForecastRepository is the persistence surface used by forecast evaluation.
type ForecastRepository interface {
	GetRun(ctx context.Context, runID string) (*models.RunDoc, error)
	AppendProcessForecasts(ctx context.Context, runID string, forecasts []models.ProcessForecast) error
}

// TimelineProviders maps prediction modes to forecast providers.
type TimelineProviders struct {
	Forecast    predictor.ForecastProvider
	TabPredict  predictor.ForecastProvider
	BQMLBoosted predictor.ForecastProvider
	TabPFN      predictor.ForecastProvider
}

// ForecastEvaluator coordinates process-forecast provider calls after ingest.
// prediction_mode=forecast → TimesFM (/forecast)
// prediction_mode=predict → TabFM (/tabpredict)
// prediction_mode=bqml-boosted → trained BQML boosted trees (/bqml-boosted)
// prediction_mode=tabpfn → TabPFN GPU (/tabpfn)
// All write the same public process_forecasts contract.
type ForecastEvaluator struct {
	repo      ForecastRepository
	providers TimelineProviders
}

// NewForecastEvaluator constructs an evaluator for the configured timeline modes.
func NewForecastEvaluator(repo ForecastRepository, providers TimelineProviders) *ForecastEvaluator {
	if providers.Forecast == nil {
		providers.Forecast = predictor.NoopForecastProvider{}
	}
	if providers.TabPredict == nil {
		providers.TabPredict = predictor.NoopForecastProvider{}
	}
	if providers.BQMLBoosted == nil {
		providers.BQMLBoosted = predictor.NoopForecastProvider{}
	}
	if providers.TabPFN == nil {
		providers.TabPFN = predictor.NoopForecastProvider{}
	}
	return &ForecastEvaluator{repo: repo, providers: providers}
}

// Evaluate loads the run then requests process forecasts for configured timeline modes.
func (e *ForecastEvaluator) Evaluate(ctx context.Context, runID string) {
	e.EvaluateLoaded(ctx, runID, nil)
}

// EvaluateLoaded evaluates against an optional preloaded run document.
// A nil runDoc is loaded from the repository (same behavior as Evaluate).
func (e *ForecastEvaluator) EvaluateLoaded(ctx context.Context, runID string, runDoc *models.RunDoc) {
	if e == nil || e.repo == nil {
		return
	}
	if runDoc == nil {
		var err error
		runDoc, err = e.repo.GetRun(ctx, runID)
		if err != nil {
			log.Printf("Forecast skipped: could not load run %s: %v", runID, err)
			return
		}
	}
	// Do not skip when Finished: prediction jobs are enqueued from /ingest and may
	// run after /finish. Throttle + AppendProcessForecasts idempotency prevent storms.
	mode := models.NormalizePredictionMode(runDoc.PredictionMode)
	provider := e.providerForMode(mode)
	if provider == nil || !predictor.ForecastEnabled(provider) {
		return
	}
	if !shouldForecast(runDoc.Samples, runDoc.ProcessForecasts, models.NormalizeThrottleElapsedS(runDoc.PredictionThrottleS)) {
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
		log.Printf("%s provider returned no forecasts for run %s (samples=%d max_elapsed=%ds)",
			mode, runID, len(runDoc.Samples), maxSampleElapsedS(runDoc.Samples))
		return
	}
	if err := e.repo.AppendProcessForecasts(ctx, runID, forecasts); err != nil {
		log.Printf("%s store failed for run %s: %v", mode, runID, err)
	}
}

func (e *ForecastEvaluator) providerForMode(mode models.PredictionMode) predictor.ForecastProvider {
	switch mode {
	case models.PredictionModeForecast:
		return e.providers.Forecast
	case models.PredictionModePredict:
		return e.providers.TabPredict
	case models.PredictionModeBQMLBoosted:
		return e.providers.BQMLBoosted
	case models.PredictionModeTabPFN:
		return e.providers.TabPFN
	default:
		return nil
	}
}

func shouldForecast(samples []models.Sample, existing []models.ProcessForecast, throttleS int) bool {
	if throttleS <= 0 {
		throttleS = models.ProcessForecastThrottleElapsedS
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
