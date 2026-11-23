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
	getRunN   int
}

func (s *forecastRepoStub) GetRun(ctx context.Context, _ string) (*models.RunDoc, error) {
	s.getRunN++
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
		PredictionMode: "disabled",
		Samples: []models.Sample{
			{ElapsedTime: 40, Timestamp: 40000, Name: "GradleDaemon", PID: "1", HeapUsed: 100, RSS: 200},
		},
	}}
	evaluator := NewForecastEvaluator(repo, TimelineProviders{Forecast: forecastProviderStub{out: []models.ProcessForecast{{
		ProcessName: "GradleDaemon", PID: "1", Metric: "heap", CreatedAtMs: 40000,
		Points: []models.ProcessForecastPoint{{TargetAtMs: 50000, ValueMB: 110}},
	}}}})
	evaluator.Evaluate(context.Background(), "run-1")
	if len(repo.appended) != 0 {
		t.Fatalf("appended = %d, want 0 for disabled mode", len(repo.appended))
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
	evaluator := NewForecastEvaluator(repo, TimelineProviders{Forecast: forecastProviderStub{out: want}})
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
	NewForecastEvaluator(repo, TimelineProviders{Forecast: forecastProviderStub{out: want}}).Evaluate(ctx, "run-1")
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
	evaluator := NewForecastEvaluator(repo, TimelineProviders{TabPredict: forecastProviderStub{out: want}})
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
	evaluator := NewForecastEvaluator(repo, TimelineProviders{BQMLBoosted: forecastProviderStub{out: want}})
	evaluator.Evaluate(context.Background(), "run-1")
	if len(repo.appended) != 1 {
		t.Fatalf("appended = %d, want 1 for bqml-boosted mode", len(repo.appended))
	}
}

func TestForecastEvaluatorAppendsForTabPFNMode(t *testing.T) {
	repo := &forecastRepoStub{run: &models.RunDoc{
		PredictionMode: "tabpfn",
		Samples: []models.Sample{
			{ElapsedTime: 40, Timestamp: 40000, Name: "GradleDaemon", PID: "1", HeapUsed: 100, RSS: 200},
		},
	}}
	want := []models.ProcessForecast{{
		ProcessName: "GradleDaemon", PID: "1", Metric: "heap", CreatedAtMs: 40000,
		Points: []models.ProcessForecastPoint{{TargetAtMs: 50000, ValueMB: 108}},
	}}
	evaluator := NewForecastEvaluator(repo, TimelineProviders{TabPFN: forecastProviderStub{out: want}})
	evaluator.Evaluate(context.Background(), "run-1")
	if len(repo.appended) != 1 {
		t.Fatalf("appended = %d, want 1 for tabpfn mode", len(repo.appended))
	}
}

func TestForecastEvaluatorUsesPerRunThrottle(t *testing.T) {
	// With throttle=20, elapsed 15s is still before the first window.
	repo := &forecastRepoStub{run: &models.RunDoc{
		PredictionMode:      "forecast",
		PredictionThrottleS: 20,
		Samples: []models.Sample{
			{ElapsedTime: 15, Timestamp: 15000, Name: "GradleDaemon", PID: "1", HeapUsed: 100, RSS: 200},
		},
	}}
	evaluator := NewForecastEvaluator(repo, TimelineProviders{Forecast: forecastProviderStub{out: []models.ProcessForecast{{
		ProcessName: "GradleDaemon", PID: "1", Metric: "heap", CreatedAtMs: 15000,
		Points: []models.ProcessForecastPoint{{TargetAtMs: 25000, ValueMB: 110}},
	}}}})
	evaluator.Evaluate(context.Background(), "run-1")
	if len(repo.appended) != 0 {
		t.Fatalf("appended = %d, want 0 at 15s with prediction_throttle_s=20", len(repo.appended))
	}

	repo.run.Samples = append(repo.run.Samples, models.Sample{
		ElapsedTime: 25, Timestamp: 25000, Name: "GradleDaemon", PID: "1", HeapUsed: 110, RSS: 210,
	})
	evaluator.Evaluate(context.Background(), "run-1")
	if len(repo.appended) != 1 {
		t.Fatalf("appended = %d, want 1 at 25s with prediction_throttle_s=20", len(repo.appended))
	}
}

func TestProcessForecastModesShareDefaultThrottle(t *testing.T) {
	for _, mode := range []string{"predict", "forecast", "bqml-boosted", "tabpfn"} {
		repo := &forecastRepoStub{run: &models.RunDoc{
			PredictionMode: mode,
			Samples: []models.Sample{
				{ElapsedTime: 25, Timestamp: 25000, Name: "GradleDaemon", PID: "1", HeapUsed: 100, RSS: 200},
			},
		}}
		want := []models.ProcessForecast{{
			ProcessName: "GradleDaemon", PID: "1", Metric: "heap", CreatedAtMs: 25000,
			Points: []models.ProcessForecastPoint{{TargetAtMs: 35000, ValueMB: 110}},
		}}
		providers := TimelineProviders{}
		switch mode {
		case "predict":
			providers.TabPredict = forecastProviderStub{out: want}
		case "bqml-boosted":
			providers.BQMLBoosted = forecastProviderStub{out: want}
		case "tabpfn":
			providers.TabPFN = forecastProviderStub{out: want}
		default:
			providers.Forecast = forecastProviderStub{out: want}
		}
		evaluator := NewForecastEvaluator(repo, providers)
		evaluator.Evaluate(context.Background(), "run-1")
		if len(repo.appended) != 1 {
			t.Fatalf("%s appended = %d, want 1 at 25s with shared 20s default throttle", mode, len(repo.appended))
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
	evaluator := NewForecastEvaluator(repo, TimelineProviders{TabPredict: forecastProviderStub{out: []models.ProcessForecast{{
		ProcessName: "GradleDaemon", PID: "1", Metric: "heap", CreatedAtMs: 40000,
		Points: []models.ProcessForecastPoint{{TargetAtMs: 50000, ValueMB: 110}},
	}}}})
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
	evaluator := NewForecastEvaluator(repo, TimelineProviders{
		Forecast: forecastProviderStub{out: []models.ProcessForecast{{
			ProcessName: "GradleDaemon", PID: "1", Metric: "rss", CreatedAtMs: 40000,
			Points: []models.ProcessForecastPoint{{TargetAtMs: 50000, ValueMB: 210}},
		}}},
		TabPredict: predictor.NoopForecastProvider{},
	})
	evaluator.Evaluate(context.Background(), "run-1")
	if len(repo.appended) != 0 {
		t.Fatalf("appended = %d, want 0 when tabpredict provider is noop", len(repo.appended))
	}
}

func TestShouldForecastAllowsSecondIssuanceAfterThrottleWindow(t *testing.T) {
	samples := []models.Sample{
		{ElapsedTime: 15, Timestamp: 1_700_000_015_000},
		{ElapsedTime: 25, Timestamp: 1_700_000_025_000},
	}
	existing := []models.ProcessForecast{{
		ProcessName: "GradleDaemon", Metric: "heap", CreatedAtMs: 1_700_000_015_000,
	}}
	if !shouldForecast(samples[:1], nil, 10) {
		t.Fatal("first issuance at 15s should be allowed")
	}
	if shouldForecast(samples[:1], existing, 10) {
		t.Fatal("second issuance in same 10s bucket must be suppressed")
	}
	if !shouldForecast(samples, existing, 10) {
		t.Fatal("second issuance at 25s (next 10s bucket) must be allowed")
	}
}

func TestShouldForecast10sBuckets(t *testing.T) {
	// Elapsed buckets with a 10s throttle: [10,20)=1, [20,30)=2, [30,40)=3.
	samples := []models.Sample{
		{ElapsedTime: 12, Timestamp: 12000},
		{ElapsedTime: 19, Timestamp: 19000},
		{ElapsedTime: 20, Timestamp: 20000},
		{ElapsedTime: 29, Timestamp: 29000},
		{ElapsedTime: 30, Timestamp: 30000},
	}
	if shouldForecast([]models.Sample{{ElapsedTime: 9, Timestamp: 9000}}, nil, 10) {
		t.Fatal("9s is before the first 10s throttle window")
	}
	if !shouldForecast(samples[:1], nil, 10) {
		t.Fatal("12s should open bucket 1")
	}
	existing := []models.ProcessForecast{{CreatedAtMs: 12000}}
	if shouldForecast(samples[:2], existing, 10) {
		t.Fatal("19s stays in bucket 1 and must suppress")
	}
	if !shouldForecast(samples[:3], existing, 10) {
		t.Fatal("20s opens bucket 2")
	}
	existing = []models.ProcessForecast{{CreatedAtMs: 20000}}
	if shouldForecast(samples[:4], existing, 10) {
		t.Fatal("29s stays in bucket 2 and must suppress")
	}
	if !shouldForecast(samples, existing, 10) {
		t.Fatal("30s opens bucket 3")
	}
}

func TestShouldForecastMapsCreatedAtMsWithoutExactTimestampMatch(t *testing.T) {
	samples := []models.Sample{
		{ElapsedTime: 15, Timestamp: 1_700_000_015_000},
		{ElapsedTime: 16, Timestamp: 1_700_000_016_000},
		{ElapsedTime: 25, Timestamp: 1_700_000_025_000},
	}
	// Provider stamped slightly after the 15s sample; exact match fails.
	existing := []models.ProcessForecast{{
		ProcessName: "GradleDaemon", Metric: "heap", CreatedAtMs: 1_700_000_015_500,
	}}
	if shouldForecast(samples[:2], existing, 10) {
		t.Fatal("near-match at ~15s must stay in bucket 1 and suppress")
	}
	if !shouldForecast(samples, existing, 10) {
		t.Fatal("elapsed 25s must open bucket 2 even without exact CreatedAtMs match")
	}
}

func TestShouldForecastNeverTreatsEpochMillisAsElapsedSeconds(t *testing.T) {
	samples := []models.Sample{
		{ElapsedTime: 15, Timestamp: 1_700_000_015_000},
		{ElapsedTime: 25, Timestamp: 1_700_000_025_000},
	}
	// Pathological wall-clock stamp far from the sample clock. Nearest-sample
	// mapping must still recover elapsed seconds; millis/1000 would be ~1.7e9.
	existing := []models.ProcessForecast{{
		ProcessName: "GradleDaemon", Metric: "heap", CreatedAtMs: 1_700_000_015_000 + 3,
	}}
	if issuanceElapsedS(samples, existing[0].CreatedAtMs) != 15 {
		t.Fatalf("issuanceElapsedS = %d, want 15", issuanceElapsedS(samples, existing[0].CreatedAtMs))
	}
	if !shouldForecast(samples, existing, 10) {
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

func TestForecastEvaluatorEvaluateLoadedSkipsGetRun(t *testing.T) {
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
	evaluator := NewForecastEvaluator(repo, TimelineProviders{Forecast: forecastProviderStub{out: want}})
	evaluator.EvaluateLoaded(context.Background(), "run-1", repo.run)
	if repo.getRunN != 0 {
		t.Fatalf("preloaded EvaluateLoaded GetRun calls = %d, want 0", repo.getRunN)
	}
	if len(repo.appended) != 1 {
		t.Fatalf("appended = %d, want 1", len(repo.appended))
	}
}

type activityRepoStub struct {
	forecastRepoStub
	activities []models.ProcessActivityForecast
}

func (s *activityRepoStub) AppendProcessActivityForecasts(_ context.Context, _ string, f []models.ProcessActivityForecast) error {
	s.activities = models.MergeActivityForecasts(s.activities, f)
	s.run.ProcessActivityForecasts = s.activities
	return nil
}

type activityProviderStub struct{ calls *int }

func (s activityProviderStub) ForecastActivity(context.Context, predictor.RunSnapshot) ([]models.ProcessActivityForecast, error) {
	*s.calls++
	return []models.ProcessActivityForecast{{ProcessName: "GradleDaemon", PID: "1", Metric: "classes_loaded", CreatedAtMs: 60000, Status: "ready"}}, nil
}
func TestActivityRoutingUnavailableAndThrottle(t *testing.T) {
	run := &models.RunDoc{PredictionMode: "tabpfn", PredictionTarget: "class_loading", Samples: []models.Sample{{Name: "GradleDaemon", PID: "1", Timestamp: 60000, ElapsedTime: 60}}}
	repo := &activityRepoStub{forecastRepoStub: forecastRepoStub{run: run}}
	calls := 0
	NewForecastEvaluator(repo, TimelineProviders{Activity: activityProviderStub{calls: &calls}}).Evaluate(context.Background(), "r")
	if calls != 1 || len(repo.activities) != 1 || len(repo.appended) != 0 {
		t.Fatal("activity was routed to memory")
	}
	NewForecastEvaluator(repo, TimelineProviders{Activity: activityProviderStub{calls: &calls}}).Evaluate(context.Background(), "r")
	if calls != 1 {
		t.Fatal("same bucket retried")
	}
	run.Samples = append(run.Samples, models.Sample{Name: "GradleDaemon", PID: "1", Timestamp: 80000, ElapsedTime: 80})
	NewForecastEvaluator(repo, TimelineProviders{}).Evaluate(context.Background(), "r")
	if len(repo.activities) != 2 || repo.activities[1].Status != "unavailable" || len(repo.activities[1].Points) != 0 {
		t.Fatal("missing provider fabricated data")
	}
}

func TestActivityModesSelectOnlyTheirProvider(t *testing.T) {
	for _, mode := range []string{"predict", "forecast", "tabpfn", "bqml-boosted", "disabled"} {
		t.Run(mode, func(t *testing.T) {
			run := &models.RunDoc{PredictionMode: mode, PredictionTarget: "class_loading", Samples: []models.Sample{{Name: "GradleDaemon", PID: "1", Timestamp: 60000, ElapsedTime: 60}}}
			repo := &activityRepoStub{forecastRepoStub: forecastRepoStub{run: run}}
			var forecastCalls, predictCalls, tabpfnCalls int
			providers := TimelineProviders{ForecastActivity: activityProviderStub{calls: &forecastCalls}, TabPredictActivity: activityProviderStub{calls: &predictCalls}, Activity: activityProviderStub{calls: &tabpfnCalls}}
			NewForecastEvaluator(repo, providers).Evaluate(context.Background(), "r")
			wantForecast, wantPredict, wantTabpfn := 0, 0, 0
			switch mode {
			case "forecast":
				wantForecast = 1
			case "predict":
				wantPredict = 1
			case "tabpfn":
				wantTabpfn = 1
			}
			if forecastCalls != wantForecast || predictCalls != wantPredict || tabpfnCalls != wantTabpfn || len(repo.appended) != 0 {
				t.Fatalf("calls=%d,%d,%d memory=%v", forecastCalls, predictCalls, tabpfnCalls, repo.appended)
			}
			if wantForecast+wantPredict+wantTabpfn == 0 {
				if len(repo.activities) != 0 {
					t.Fatal("unsupported mode produced activity")
				}
				return
			}
			run.ProcessActivityForecasts = nil
			repo.activities = nil
			NewForecastEvaluator(repo, TimelineProviders{}).Evaluate(context.Background(), "r")
			if len(repo.activities) != 1 || repo.activities[0].Status != "unavailable" || len(repo.activities[0].Points) != 0 {
				t.Fatalf("missing provider: %v", repo.activities)
			}
		})
	}
}
