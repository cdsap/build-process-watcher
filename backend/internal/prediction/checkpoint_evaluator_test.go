package prediction

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/models"
	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
)

type fakeRepo struct {
	run        *models.RunDoc
	runErr     error
	process    *models.ProcessDoc
	processErr error
	storeErr   error
	stored     []models.PredictionCheckpoint
	getRunN    int
	getProcN   int
	storeN     int
}

func (f *fakeRepo) GetRun(string) (*models.RunDoc, error) {
	f.getRunN++
	if f.runErr != nil {
		return nil, f.runErr
	}
	return f.run, nil
}

func (f *fakeRepo) GetProcesses(runID string) (*models.ProcessDoc, error) {
	f.getProcN++
	if f.processErr != nil {
		return nil, f.processErr
	}
	if f.process == nil {
		return &models.ProcessDoc{
			RunID:       runID,
			ProcessInfo: make(map[string]models.ProcessInfo),
		}, nil
	}
	return f.process, nil
}

func (f *fakeRepo) StorePredictionCheckpoint(_ string, checkpoint models.PredictionCheckpoint) error {
	f.storeN++
	if f.storeErr != nil {
		return f.storeErr
	}
	f.stored = append(f.stored, checkpoint)
	return nil
}

type stubProvider struct {
	checkpoint models.PredictionCheckpoint
	err        error
	calls      int
	lastSnap   predictor.RunSnapshot
	lastWindow int
}

func (s *stubProvider) Predict(_ context.Context, snapshot predictor.RunSnapshot, observationWindowS int) (models.PredictionCheckpoint, error) {
	s.calls++
	s.lastSnap = snapshot
	s.lastWindow = observationWindowS
	if s.err != nil {
		return models.PredictionCheckpoint{}, s.err
	}
	return s.checkpoint, nil
}

func enabledRun(samples []models.Sample) *models.RunDoc {
	return &models.RunDoc{
		RunID:                 "run-1",
		PredictiveReliability: true,
		Samples:               samples,
	}
}

func TestCheckpointEvaluatorDisabledProvider(t *testing.T) {
	repo := &fakeRepo{run: enabledRun([]models.Sample{{ElapsedTime: 120}})}
	evaluator := NewCheckpointEvaluator(repo, predictor.NoopProvider{}, []int{60}, nil)
	evaluator.Evaluate(context.Background(), "run-1")
	if repo.getRunN != 0 || repo.storeN != 0 {
		t.Fatalf("disabled provider should skip evaluation; getRun=%d store=%d", repo.getRunN, repo.storeN)
	}
}

func TestCheckpointEvaluatorPredictiveReliabilityFalse(t *testing.T) {
	repo := &fakeRepo{
		run: &models.RunDoc{
			RunID:                 "run-1",
			PredictiveReliability: false,
			Samples:               []models.Sample{{ElapsedTime: 120}},
		},
	}
	provider := &stubProvider{
		checkpoint: models.PredictionCheckpoint{ObservationWindowS: 60, Status: "ready"},
	}
	evaluator := NewCheckpointEvaluator(repo, provider, []int{60}, nil)
	evaluator.Evaluate(context.Background(), "run-1")
	if repo.getRunN != 1 {
		t.Fatalf("getRun calls = %d, want 1", repo.getRunN)
	}
	if provider.calls != 0 || repo.storeN != 0 {
		t.Fatalf("predictive_reliability=false should not predict; provider=%d store=%d", provider.calls, repo.storeN)
	}
}

func TestCheckpointEvaluatorMissingProcessInfoFallback(t *testing.T) {
	repo := &fakeRepo{
		run:        enabledRun([]models.Sample{{ElapsedTime: 90}}),
		processErr: errors.New("processes not found"),
	}
	provider := &stubProvider{
		checkpoint: models.PredictionCheckpoint{
			ObservationWindowS: 60,
			Status:             "ready",
			CreatedAt:          time.Unix(100, 0).UTC(),
		},
	}
	evaluator := NewCheckpointEvaluator(repo, provider, []int{60}, nil)
	evaluator.Evaluate(context.Background(), "run-1")
	if provider.calls != 1 {
		t.Fatalf("provider calls = %d, want 1", provider.calls)
	}
	if provider.lastSnap.ProcessInfo == nil {
		t.Fatal("expected empty process info map after GetProcesses failure")
	}
	if len(provider.lastSnap.ProcessInfo) != 0 {
		t.Fatalf("process info = %v, want empty map", provider.lastSnap.ProcessInfo)
	}
	if repo.storeN != 1 {
		t.Fatalf("store calls = %d, want 1", repo.storeN)
	}
}

func TestCheckpointEvaluatorProviderErrorFallback(t *testing.T) {
	repo := &fakeRepo{run: enabledRun([]models.Sample{{ElapsedTime: 90}})}
	provider := &stubProvider{err: fmt.Errorf("private stack: customer id 99: boom")}
	evaluator := NewCheckpointEvaluator(repo, provider, []int{60}, func(error) (string, string) {
		return "provider_error", "prediction provider error"
	})
	evaluator.Evaluate(context.Background(), "run-1")
	if repo.storeN != 1 {
		t.Fatalf("store calls = %d, want 1", repo.storeN)
	}
	got := repo.stored[0]
	if got.ObservationWindowS != 60 {
		t.Fatalf("ObservationWindowS = %d, want 60", got.ObservationWindowS)
	}
	if got.Status != "provider_error" {
		t.Fatalf("Status = %q, want provider_error", got.Status)
	}
	if got.Message != "prediction provider error" {
		t.Fatalf("Message = %q, want public-safe fallback", got.Message)
	}
	if strings.Contains(got.Message, "customer id") {
		t.Fatal("fallback checkpoint leaked private diagnostic text")
	}
	if got.CreatedAt.IsZero() {
		t.Fatal("CreatedAt should be set on fallback checkpoint")
	}
}

func TestCheckpointEvaluatorSuccessfulCheckpointStorage(t *testing.T) {
	repo := &fakeRepo{
		run: enabledRun([]models.Sample{{ElapsedTime: 300}}),
		process: &models.ProcessDoc{
			RunID: "run-1",
			ProcessInfo: map[string]models.ProcessInfo{
				"1": {PID: "1", Name: "GradleDaemon"},
			},
		},
	}
	provider := &stubProvider{
		checkpoint: models.PredictionCheckpoint{
			Status: "ready",
			// Zero ObservationWindowS and CreatedAt exercise defaults.
		},
	}
	evaluator := NewCheckpointEvaluator(repo, provider, []int{60, 300}, nil)
	evaluator.Evaluate(context.Background(), "run-1")
	if provider.calls != 2 {
		t.Fatalf("provider calls = %d, want 2 pending windows", provider.calls)
	}
	if repo.storeN != 2 {
		t.Fatalf("store calls = %d, want 2", repo.storeN)
	}
	if len(repo.stored) != 2 {
		t.Fatalf("stored = %d, want 2", len(repo.stored))
	}
	if repo.stored[0].ObservationWindowS != 60 || repo.stored[1].ObservationWindowS != 300 {
		t.Fatalf("stored windows = [%d %d], want [60 300]", repo.stored[0].ObservationWindowS, repo.stored[1].ObservationWindowS)
	}
	for i, checkpoint := range repo.stored {
		if checkpoint.CreatedAt.IsZero() {
			t.Fatalf("stored[%d].CreatedAt is zero", i)
		}
		if checkpoint.Status != "ready" {
			t.Fatalf("stored[%d].Status = %q, want ready", i, checkpoint.Status)
		}
	}
	if provider.lastSnap.ProcessInfo["1"].Name != "GradleDaemon" {
		t.Fatalf("process info not passed through: %+v", provider.lastSnap.ProcessInfo)
	}
}

func TestNewCheckpointEvaluatorDefaultsFallbackClassifier(t *testing.T) {
	evaluator := NewCheckpointEvaluator(nil, nil, nil, nil)
	err := fmt.Errorf("private stack: customer id 9: boom")
	state, message := evaluator.FallbackClassifier()(err)
	if state != "provider_error" || message != "prediction provider error" {
		t.Fatalf("classifier = (%q, %q), want default public-safe mapping", state, message)
	}
	if strings.Contains(message, "customer id") || message == err.Error() {
		t.Fatal("default fallback classifier leaked private diagnostic text")
	}
}

func TestNewCheckpointEvaluatorUsesInjectedFallbackClassifier(t *testing.T) {
	evaluator := NewCheckpointEvaluator(nil, predictor.NoopProvider{}, nil, func(error) (string, string) {
		return "no_data", "prediction data unavailable"
	})
	state, message := evaluator.FallbackClassifier()(errors.New("ignored"))
	if state != "no_data" || message != "prediction data unavailable" {
		t.Fatalf("classifier = (%q, %q), want injected mapping", state, message)
	}
}
