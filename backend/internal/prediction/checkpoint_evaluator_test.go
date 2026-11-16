package prediction

import (
	"context"
	"testing"

	"github.com/cdsap/build-process-watcher/backend/internal/models"
	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
)

type fakeRepo struct {
	getRunN int
}

func (f *fakeRepo) GetRun(context.Context, string) (*models.RunDoc, error) {
	f.getRunN++
	return &models.RunDoc{PredictiveReliability: true}, nil
}
func (f *fakeRepo) GetProcesses(context.Context, string) (*models.ProcessDoc, error) {
	return &models.ProcessDoc{}, nil
}
func (f *fakeRepo) StorePredictionCheckpoint(context.Context, string, models.PredictionCheckpoint) error {
	return nil
}

func TestCheckpointEvaluatorRetiredIsNoop(t *testing.T) {
	repo := &fakeRepo{}
	evaluator := NewCheckpointEvaluator(repo, predictor.NoopProvider{}, []int{60}, nil)
	evaluator.Evaluate(context.Background(), "run-1")
	evaluator.EvaluateLoaded(context.Background(), "run-1", &models.RunDoc{PredictiveReliability: true}, nil)
	if repo.getRunN != 0 {
		t.Fatalf("retired evaluator should not load runs; getRun=%d", repo.getRunN)
	}
}
