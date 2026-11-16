package prediction

import (
	"context"

	"github.com/cdsap/build-process-watcher/backend/internal/models"
	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
)

// CheckpointRepository is retained for storage compatibility with legacy runs.
type CheckpointRepository interface {
	GetRun(ctx context.Context, runID string) (*models.RunDoc, error)
	GetProcesses(ctx context.Context, runID string) (*models.ProcessDoc, error)
	StorePredictionCheckpoint(ctx context.Context, runID string, checkpoint models.PredictionCheckpoint) error
}

// CheckpointEvaluator previously produced reliability checkpoints via the private
// /predict provider. That mode is retired; methods are no-ops.
type CheckpointEvaluator struct{}

// NewCheckpointEvaluator returns a retired no-op evaluator.
func NewCheckpointEvaluator(repo CheckpointRepository, provider predictor.Provider, checkpoints []int, fallbackClassifier predictor.FallbackClassifier) *CheckpointEvaluator {
	return &CheckpointEvaluator{}
}

// FallbackClassifier is retained for call-site compatibility; always nil.
func (e *CheckpointEvaluator) FallbackClassifier() predictor.FallbackClassifier { return nil }

// Evaluate is a no-op; reliability prediction is retired.
func (e *CheckpointEvaluator) Evaluate(ctx context.Context, runID string) {}

// EvaluateLoaded is a no-op; reliability prediction is retired.
func (e *CheckpointEvaluator) EvaluateLoaded(ctx context.Context, runID string, runDoc *models.RunDoc, processDoc *models.ProcessDoc) {
}
