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
}

func (s *forecastRepoStub) GetRun(string) (*models.RunDoc, error) { return s.run, nil }
func (s *forecastRepoStub) AppendProcessForecasts(_ string, forecasts []models.ProcessForecast) error {
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
	evaluator := NewForecastEvaluator(repo, forecastProviderStub{out: []models.ProcessForecast{{
		ProcessName: "GradleDaemon", PID: "1", Metric: "heap", CreatedAtMs: 40000,
		Points: []models.ProcessForecastPoint{{TargetAtMs: 50000, ValueMB: 110}},
	}}})
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
	evaluator := NewForecastEvaluator(repo, forecastProviderStub{out: want})
	evaluator.Evaluate(context.Background(), "run-1")
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
	evaluator := NewForecastEvaluatorWithTabPredict(repo, forecastProviderStub{}, forecastProviderStub{out: want})
	evaluator.Evaluate(context.Background(), "run-1")
	if len(repo.appended) != 1 {
		t.Fatalf("appended = %d, want 1 for predict mode", len(repo.appended))
	}
}

func TestPredictModeUses20sThrottle(t *testing.T) {
	repo := &forecastRepoStub{run: &models.RunDoc{
		PredictionMode: "predict",
		Samples: []models.Sample{
			{ElapsedTime: 25, Timestamp: 25000, Name: "GradleDaemon", PID: "1", HeapUsed: 100, RSS: 200},
		},
	}}
	evaluator := NewForecastEvaluatorWithTabPredict(repo, predictor.NoopForecastProvider{}, forecastProviderStub{out: []models.ProcessForecast{{
		ProcessName: "GradleDaemon", PID: "1", Metric: "heap", CreatedAtMs: 25000,
		Points: []models.ProcessForecastPoint{{TargetAtMs: 35000, ValueMB: 110}},
	}}})
	evaluator.Evaluate(context.Background(), "run-1")
	if len(repo.appended) != 1 {
		t.Fatalf("appended = %d, want 1 at 25s with predict 20s throttle", len(repo.appended))
	}

	repo = &forecastRepoStub{run: &models.RunDoc{
		PredictionMode: "forecast",
		Samples: []models.Sample{
			{ElapsedTime: 25, Timestamp: 25000, Name: "GradleDaemon", PID: "1", HeapUsed: 100, RSS: 200},
		},
	}}
	evaluator = NewForecastEvaluator(repo, forecastProviderStub{out: []models.ProcessForecast{{
		ProcessName: "GradleDaemon", PID: "1", Metric: "heap", CreatedAtMs: 25000,
		Points: []models.ProcessForecastPoint{{TargetAtMs: 35000, ValueMB: 110}},
	}}})
	evaluator.Evaluate(context.Background(), "run-1")
	if len(repo.appended) != 0 {
		t.Fatalf("appended = %d, want 0 at 25s with forecast 30s throttle", len(repo.appended))
	}
}

func TestForecastEvaluatorIgnoresForecastProviderInPredictMode(t *testing.T) {
	repo := &forecastRepoStub{run: &models.RunDoc{
		PredictionMode: "predict",
		Samples: []models.Sample{
			{ElapsedTime: 40, Timestamp: 40000, Name: "GradleDaemon", PID: "1", HeapUsed: 100, RSS: 200},
		},
	}}
	evaluator := NewForecastEvaluatorWithTabPredict(repo, forecastProviderStub{out: []models.ProcessForecast{{
		ProcessName: "GradleDaemon", PID: "1", Metric: "rss", CreatedAtMs: 40000,
		Points: []models.ProcessForecastPoint{{TargetAtMs: 50000, ValueMB: 210}},
	}}}, predictor.NoopForecastProvider{})
	evaluator.Evaluate(context.Background(), "run-1")
	if len(repo.appended) != 0 {
		t.Fatalf("appended = %d, want 0 when tabpredict provider is noop", len(repo.appended))
	}
}
