package relprogress

import (
	"context"
	"fmt"

	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
)

// ScoredCandidate pairs a privately derived candidate with a public-safe checkpoint.
type ScoredCandidate struct {
	Candidate  Candidate
	Checkpoint predictor.PredictionCheckpoint
}

// ScoreCandidates scores each candidate through the existing provider contract.
// Output remains the public PredictionCheckpoint shape; relative progress is
// carried only as observation_window_s.
func ScoreCandidates(ctx context.Context, provider predictor.Provider, snapshot predictor.RunSnapshot, candidates []Candidate) ([]ScoredCandidate, error) {
	if provider == nil {
		return nil, fmt.Errorf("provider is required")
	}
	scored := make([]ScoredCandidate, 0, len(candidates))
	existing := append([]predictor.PredictionCheckpoint(nil), snapshot.ExistingCheckpoints...)

	for _, candidate := range candidates {
		local := snapshot
		local.ExistingCheckpoints = existing
		local.Samples = samplesThrough(snapshot.Samples, candidate.ObservationWindowS)
		if len(local.Samples) == 0 {
			return nil, fmt.Errorf("score candidate %ds: no samples at or before window", candidate.ObservationWindowS)
		}
		checkpoint, err := provider.Predict(ctx, local, candidate.ObservationWindowS)
		if err != nil {
			return nil, fmt.Errorf("score candidate %ds: %w", candidate.ObservationWindowS, err)
		}
		if checkpoint.ObservationWindowS == 0 {
			checkpoint.ObservationWindowS = candidate.ObservationWindowS
		}
		scored = append(scored, ScoredCandidate{
			Candidate:  candidate,
			Checkpoint: checkpoint,
		})
		if checkpoint.Status == "ready" {
			existing = append(existing, checkpoint)
		}
	}
	return scored, nil
}

// PendingRelativeWindows returns relative-progress observation windows that are
// reached by live samples and not already stored, without changing the public
// configured-window schema.
func PendingRelativeWindows(snapshot predictor.RunSnapshot, options MapOptions) []int {
	candidates := RelativeOnly(MapLiveCandidates(snapshot, options))
	elapsed := int(maxElapsedS(snapshot.Samples))
	stored := make(map[int]bool, len(snapshot.ExistingCheckpoints))
	for _, checkpoint := range snapshot.ExistingCheckpoints {
		stored[checkpoint.ObservationWindowS] = true
	}

	pending := make([]int, 0, len(candidates))
	seen := make(map[int]bool, len(candidates))
	for _, candidate := range candidates {
		window := candidate.ObservationWindowS
		if window <= 0 || seen[window] || stored[window] || elapsed < window {
			continue
		}
		seen[window] = true
		pending = append(pending, window)
	}
	return pending
}

func samplesThrough(samples []predictor.Sample, observationWindowS int) []predictor.Sample {
	if observationWindowS <= 0 {
		return nil
	}
	filtered := make([]predictor.Sample, 0, len(samples))
	for _, sample := range samples {
		if sample.ElapsedTime <= observationWindowS {
			filtered = append(filtered, sample)
		}
	}
	return filtered
}
