package prediction

import (
	"context"
	"testing"

	"github.com/cdsap/build-process-watcher/backend/internal/models"
	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
)

type forecastRepoStub struct {
	run       *models.RunDoc
	appended  []models.ProcessForecast
	appendErr error
	lastCtx   context.Context
}

func (s *forecastRepoStub) GetRun(ctx context.Context, _ string) (*models.RunDoc, error) {
	s.lastCtx = ctx
	return s.run, nil
}
func (s *forecastRepoStub) AppendProcessForecasts(ctx context.Context, _ string, forecasts []models.ProcessForecast) error {
	s.lastCtx = ctx
	s.appended = append(s.appended, forecasts...)
	return s.appendErr
}

type forecastProviderStub struct {
	out []models.ProcessForecast
	err error
}

func (s forecastProviderStub) Forecast(context.Context, predictor.RunSnapshot) ([]models.ProcessForecast, error) {
	return s.out, s.err
}

func TestForecastEvaluatorOnlyRunsForForecastMode(t *testing.T) {
	repo := &forecastRepoStub{run: &models.RunDoc{
		PredictionMode: "reliability",
		Samples: []models.Sample{
			{ElapsedTime: 40, Timestamp: 40000, Name: "GradleDaemon", PID: "1", HeapUsed: 100, RSS: 200},
		},
	}}
	evaluator := NewForecastEvaluator(repo, predictor.ForecastProviders{
		predictor.PredictionModeForecast: forecastProviderStub{out: []models.ProcessForecast{{
			ProcessName: "GradleDaemon", PID: "1", Metric: "heap", CreatedAtMs: 40000,
			Points: []models.ProcessForecastPoint{{TargetAtMs: 50000, ValueMB: 110}},
		}}},
	})
	evaluator.Evaluate(context.Background(), "run-1")
	if len(repo.appended) != 0 {
		t.Fatalf("appended = %d, want 0 for reliability mode", len(repo.appended))
	}
}

func TestForecastEvaluatorAppendsForForecastMode(t *testing.T) {
	repo := &forecastRepoStub{run: &models.RunDoc{
		PredictionMode: "forecast",
		Samples: []models.Sample{
			{ElapsedTime: 40, Timestamp: 40000, Name: "GradleDaemon", PID: "1", HeapUsed: 100, RSS: 200},
		},
	}}
	want := []models.ProcessForecast{{
		ProcessName: "GradleDaemon", PID: "1", Metric: "rss", CreatedAtMs: 40000,
		Points: []models.ProcessForecastPoint{{TargetAtMs: 50000, ValueMB: 210}},
	}}
	evaluator := NewForecastEvaluator(repo, predictor.ForecastProviders{
		predictor.PredictionModeForecast: forecastProviderStub{out: want},
	})
	evaluator.Evaluate(context.Background(), "run-1")
	if len(repo.appended) != 1 {
		t.Fatalf("appended = %d, want 1", len(repo.appended))
	}
}

func TestForecastEvaluatorPropagatesContextToRepo(t *testing.T) {
	repo := &forecastRepoStub{run: &models.RunDoc{
		PredictionMode: "forecast",
		Samples: []models.Sample{
			{ElapsedTime: 40, Timestamp: 40000, Name: "GradleDaemon", PID: "1", HeapUsed: 100, RSS: 200},
		},
	}}
	want := []models.ProcessForecast{{
		ProcessName: "GradleDaemon", PID: "1", Metric: "rss", CreatedAtMs: 40000,
		Points: []models.ProcessForecastPoint{{TargetAtMs: 50000, ValueMB: 210}},
	}}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	NewForecastEvaluator(repo, predictor.ForecastProviders{
		predictor.PredictionModeForecast: forecastProviderStub{out: want},
	}).Evaluate(ctx, "run-1")
	if repo.lastCtx == nil || repo.lastCtx.Err() != context.Canceled {
		t.Fatalf("repo ctx err = %v, want context.Canceled", repo.lastCtx.Err())
	}
	if len(repo.appended) != 1 {
		t.Fatalf("appended = %d, want 1", len(repo.appended))
	}
}

func TestForecastEvaluatorAppendsForPredictMode(t *testing.T) {
	repo := &forecastRepoStub{run: &models.RunDoc{
		PredictionMode: "predict",
		Samples: []models.Sample{
			{ElapsedTime: 40, Timestamp: 40000, Name: "GradleDaemon", PID: "1", HeapUsed: 100, RSS: 200},
		},
	}}
	want := []models.ProcessForecast{{
		ProcessName: "GradleDaemon", PID: "1", Metric: "heap", CreatedAtMs: 40000,
		Points: []models.ProcessForecastPoint{{TargetAtMs: 50000, ValueMB: 105}},
	}}
	evaluator := NewForecastEvaluator(repo, predictor.ForecastProviders{
		predictor.PredictionModePredict: forecastProviderStub{out: want},
	})
	evaluator.Evaluate(context.Background(), "run-1")
	if len(repo.appended) != 1 {
		t.Fatalf("appended = %d, want 1 for predict mode", len(repo.appended))
	}
}

func TestForecastEvaluatorAppendsForBQMLBoostedMode(t *testing.T) {
	repo := &forecastRepoStub{run: &models.RunDoc{
		PredictionMode: "bqml-boosted",
		Samples: []models.Sample{
			{ElapsedTime: 40, Timestamp: 40000, Name: "GradleDaemon", PID: "1", HeapUsed: 100, RSS: 200},
		},
	}}
	want := []models.ProcessForecast{{
		ProcessName: "GradleDaemon", PID: "1", Metric: "heap", CreatedAtMs: 40000,
		Points: []models.ProcessForecastPoint{{TargetAtMs: 50000, ValueMB: 108}},
	}}
	evaluator := NewForecastEvaluator(repo, predictor.ForecastProviders{
		predictor.PredictionModeBQMLBoosted: forecastProviderStub{out: want},
	})
	evaluator.Evaluate(context.Background(), "run-1")
	if len(repo.appended) != 1 {
		t.Fatalf("appended = %d, want 1 for bqml-boosted mode", len(repo.appended))
	}
}

func TestProcessForecastModesShare20sThrottle(t *testing.T) {
	for _, mode := range []predictor.PredictionMode{
		predictor.PredictionModePredict,
		predictor.PredictionModeForecast,
		predictor.PredictionModeBQMLBoosted,
	} {
		repo := &forecastRepoStub{run: &models.RunDoc{
			PredictionMode: string(mode),
			Samples: []models.Sample{
				{ElapsedTime: 25, Timestamp: 25000, Name: "GradleDaemon", PID: "1", HeapUsed: 100, RSS: 200},
			},
		}}
		want := []models.ProcessForecast{{
			ProcessName: "GradleDaemon", PID: "1", Metric: "heap", CreatedAtMs: 25000,
			Points: []models.ProcessForecastPoint{{TargetAtMs: 35000, ValueMB: 110}},
		}}
		evaluator := NewForecastEvaluator(repo, predictor.ForecastProviders{
			mode: forecastProviderStub{out: want},
		})
		evaluator.Evaluate(context.Background(), "run-1")
		if len(repo.appended) != 1 {
			t.Fatalf("%s appended = %d, want 1 at 25s with shared 20s throttle", mode, len(repo.appended))
		}
	}
}

func TestForecastEvaluatorAllowsFinishedRunsForLateJobs(t *testing.T) {
	repo := &forecastRepoStub{run: &models.RunDoc{
		Finished:       true,
		PredictionMode: "predict",
		Samples: []models.Sample{
			{ElapsedTime: 40, Timestamp: 40000, Name: "GradleDaemon", PID: "1", HeapUsed: 100, RSS: 200},
		},
	}}
	evaluator := NewForecastEvaluator(repo, predictor.ForecastProviders{
		predictor.PredictionModePredict: forecastProviderStub{out: []models.ProcessForecast{{
			ProcessName: "GradleDaemon", PID: "1", Metric: "heap", CreatedAtMs: 40000,
			Points: []models.ProcessForecastPoint{{TargetAtMs: 50000, ValueMB: 110}},
		}}},
	})
	evaluator.Evaluate(context.Background(), "run-1")
	if len(repo.appended) != 1 {
		t.Fatalf("appended = %d, want 1 for late job after finish", len(repo.appended))
	}
}

func TestForecastEvaluatorIgnoresForecastProviderInPredictMode(t *testing.T) {
	repo := &forecastRepoStub{run: &models.RunDoc{
		PredictionMode: "predict",
		Samples: []models.Sample{
			{ElapsedTime: 40, Timestamp: 40000, Name: "GradleDaemon", PID: "1", HeapUsed: 100, RSS: 200},
		},
	}}
	evaluator := NewForecastEvaluator(repo, predictor.ForecastProviders{
		predictor.PredictionModeForecast: forecastProviderStub{out: []models.ProcessForecast{{
			ProcessName: "GradleDaemon", PID: "1", Metric: "rss", CreatedAtMs: 40000,
			Points: []models.ProcessForecastPoint{{TargetAtMs: 50000, ValueMB: 210}},
		}}},
		predictor.PredictionModePredict: predictor.NoopForecastProvider{},
	})
	evaluator.Evaluate(context.Background(), "run-1")
	if len(repo.appended) != 0 {
		t.Fatalf("appended = %d, want 0 when tabpredict provider is noop", len(repo.appended))
	}
}

func TestShouldForecastAllowsSecondIssuanceAfterThrottleWindow(t *testing.T) {
	samples := []models.Sample{
		{ElapsedTime: 25, Timestamp: 1_700_000_025_000},
		{ElapsedTime: 45, Timestamp: 1_700_000_045_000},
	}
	existing := []models.ProcessForecast{{
		ProcessName: "GradleDaemon", Metric: "heap", CreatedAtMs: 1_700_000_025_000,
	}}
	if !shouldForecast(samples[:1], nil, 20) {
		t.Fatal("first issuance at 25s should be allowed")
	}
	if shouldForecast(samples[:1], existing, 20) {
		t.Fatal("second issuance in same 20s bucket must be suppressed")
	}
	if !shouldForecast(samples, existing, 20) {
		t.Fatal("second issuance at 45s (next 20s bucket) must be allowed")
	}
}

func TestShouldForecastMapsCreatedAtMsWithoutExactTimestampMatch(t *testing.T) {
	samples := []models.Sample{
		{ElapsedTime: 25, Timestamp: 1_700_000_025_000},
		{ElapsedTime: 26, Timestamp: 1_700_000_026_000},
		{ElapsedTime: 45, Timestamp: 1_700_000_045_000},
	}
	// Provider stamped slightly after the 25s sample; exact match fails.
	existing := []models.ProcessForecast{{
		ProcessName: "GradleDaemon", Metric: "heap", CreatedAtMs: 1_700_000_025_500,
	}}
	if shouldForecast(samples[:2], existing, 20) {
		t.Fatal("near-match at ~25s must stay in bucket 1 and suppress")
	}
	if !shouldForecast(samples, existing, 20) {
		t.Fatal("elapsed 45s must open bucket 2 even without exact CreatedAtMs match")
	}
}

func TestShouldForecastNeverTreatsEpochMillisAsElapsedSeconds(t *testing.T) {
	samples := []models.Sample{
		{ElapsedTime: 25, Timestamp: 1_700_000_025_000},
		{ElapsedTime: 45, Timestamp: 1_700_000_045_000},
	}
	// Pathological wall-clock stamp far from the sample clock. Nearest-sample
	// mapping must still recover elapsed seconds; millis/1000 would be ~1.7e9.
	existing := []models.ProcessForecast{{
		ProcessName: "GradleDaemon", Metric: "heap", CreatedAtMs: 1_700_000_025_000 + 3,
	}}
	if issuanceElapsedS(samples, existing[0].CreatedAtMs) != 25 {
		t.Fatalf("issuanceElapsedS = %d, want 25", issuanceElapsedS(samples, existing[0].CreatedAtMs))
	}
	if !shouldForecast(samples, existing, 20) {
		t.Fatal("second bucket must not be permanently suppressed by epoch-ms/1000")
	}
}

func TestIssuanceElapsedSPrefersExactThenNearestBefore(t *testing.T) {
	samples := []models.Sample{
		{ElapsedTime: 20, Timestamp: 20000},
		{ElapsedTime: 40, Timestamp: 40000},
	}
	if got := issuanceElapsedS(samples, 40000); got != 40 {
		t.Fatalf("exact = %d, want 40", got)
	}
	if got := issuanceElapsedS(samples, 39999); got != 20 {
		t.Fatalf("nearest-before = %d, want 20", got)
	}
	if got := issuanceElapsedS(samples, 50000); got != 40 {
		t.Fatalf("after last sample = %d, want 40", got)
	}
}
