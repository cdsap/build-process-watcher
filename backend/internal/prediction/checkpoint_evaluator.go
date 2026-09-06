package prediction

import (
	"context"
	"log"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/models"
	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
)

// CheckpointRepository is the persistence surface used by checkpoint evaluation.
type CheckpointRepository interface {
	GetRun(runID string) (*models.RunDoc, error)
	GetProcesses(runID string) (*models.ProcessDoc, error)
	StorePredictionCheckpoint(runID string, checkpoint models.PredictionCheckpoint) error
}

// CheckpointEvaluator coordinates predictive checkpoint selection, provider calls,
// fallbacks, and persistence after samples are stored.
type CheckpointEvaluator struct {
	repo               CheckpointRepository
	provider           predictor.Provider
	checkpoints        []int
	fallbackClassifier predictor.FallbackClassifier
}

// NewCheckpointEvaluator constructs an evaluator. A nil provider or classifier
// uses the same defaults as the former handler wiring.
func NewCheckpointEvaluator(repo CheckpointRepository, provider predictor.Provider, checkpoints []int, fallbackClassifier predictor.FallbackClassifier) *CheckpointEvaluator {
	if provider == nil {
		provider = predictor.NoopProvider{}
	}
	if fallbackClassifier == nil {
		fallbackClassifier = predictor.DefaultFallbackClassifier
	}
	return &CheckpointEvaluator{
		repo:               repo,
		provider:           provider,
		checkpoints:        checkpoints,
		fallbackClassifier: fallbackClassifier,
	}
}

// FallbackClassifier exposes the configured classifier for composition-root tests.
func (e *CheckpointEvaluator) FallbackClassifier() predictor.FallbackClassifier {
	if e == nil {
		return nil
	}
	return e.fallbackClassifier
}

// Evaluate loads run state, predicts any pending configured windows, and stores
// public-safe checkpoints. Missing process info continues with an empty map.
func (e *CheckpointEvaluator) Evaluate(ctx context.Context, runID string) {
	if e == nil || e.repo == nil || !predictor.Enabled(e.provider) || len(e.checkpoints) == 0 {
		return
	}

	runDoc, err := e.repo.GetRun(runID)
	if err != nil {
		log.Printf("Prediction skipped: could not load run %s: %v", runID, err)
		return
	}
	if !runDoc.PredictiveReliability {
		return
	}
	processDoc, err := e.repo.GetProcesses(runID)
	if err != nil {
		log.Printf("Prediction continuing without process info for run %s: %v", runID, err)
		processDoc = &models.ProcessDoc{
			RunID:       runID,
			ProcessInfo: make(map[string]models.ProcessInfo),
		}
	}

	pending := predictor.PendingCheckpoints(runDoc.Samples, runDoc.PredictionCheckpoints, e.checkpoints)
	for _, checkpointWindow := range pending {
		checkpoint, err := e.provider.Predict(ctx, predictor.RunSnapshot{
			RunID:                 runID,
			Samples:               runDoc.Samples,
			ProcessInfo:           processDoc.ProcessInfo,
			ExistingCheckpoints:   runDoc.PredictionCheckpoints,
			ConfiguredCheckpoints: e.checkpoints,
			Now:                   time.Now(),
		}, checkpointWindow)
		if err != nil {
			_, _, _, checkpoint = predictor.FallbackForError(err, checkpointWindow, time.Now(), e.fallbackClassifier)
			log.Printf("Prediction provider failed for run %s checkpoint %ds: %v", runID, checkpointWindow, err)
		}
		if checkpoint.ObservationWindowS == 0 {
			checkpoint.ObservationWindowS = checkpointWindow
		}
		if checkpoint.CreatedAt.IsZero() {
			checkpoint.CreatedAt = time.Now()
		}
		if err := e.repo.StorePredictionCheckpoint(runID, checkpoint); err != nil {
			log.Printf("Prediction checkpoint store failed for run %s checkpoint %ds: %v", runID, checkpointWindow, err)
			continue
		}
		runDoc.PredictionCheckpoints = predictor.MergePredictionCheckpoint(runDoc.PredictionCheckpoints, checkpoint)
	}
}
