package promotion

import (
	"fmt"
	"time"
)

const (
	ActionPromote     = "promote"
	ActionRetain      = "retain"
	ActionNoPromotion = "no_promotion"
)

// Refresh applies independent checkpoint promotion decisions.
// Failed or sparse windows leave any previously promoted model in place.
func Refresh(previous Registry, report QualityReport, gate Gate, dryRun bool, now time.Time) (RefreshResult, error) {
	if now.IsZero() {
		now = time.Now().UTC()
	} else {
		now = now.UTC()
	}

	byWindow := make(map[int]CheckpointQuality, len(report.Checkpoints))
	for _, checkpoint := range report.Checkpoints {
		if checkpoint.ObservationWindowS <= 0 {
			return RefreshResult{}, fmt.Errorf("quality report contains invalid observation_window_s")
		}
		if _, exists := byWindow[checkpoint.ObservationWindowS]; exists {
			return RefreshResult{}, fmt.Errorf("quality report duplicates observation_window_s %d", checkpoint.ObservationWindowS)
		}
		byWindow[checkpoint.ObservationWindowS] = checkpoint
	}

	previousByWindow := make(map[int]PromotedModel, len(previous.Models))
	for _, model := range previous.Normalize().Models {
		previousByWindow[model.ObservationWindowS] = model
	}

	result := RefreshResult{
		DryRun:          dryRun,
		ModelSetVersion: report.ModelSetVersion,
		Gate:            gate,
		Decisions:       make([]Decision, 0, len(CheckpointWindows)),
		Registry:        Registry{Models: make([]PromotedModel, 0, len(CheckpointWindows))},
	}

	for _, window := range CheckpointWindows {
		previousModel := previousByWindow[window]
		checkpoint, found := byWindow[window]
		decision := Decision{
			ObservationWindowS: window,
			PreviousVersion:    previousModel.ModelVersion,
		}

		if !found {
			decision.Action = retainOrSkip(previousModel.ModelVersion)
			decision.GateStatus = GateStatusMissingEvidence
			decision.Reasons = []string{"missing checkpoint quality window"}
			decision.ModelVersion = previousModel.ModelVersion
			result.Decisions = append(result.Decisions, decision)
			if previousModel.ModelVersion != "" {
				result.Registry.Models = append(result.Registry.Models, previousModel)
			}
			continue
		}

		decision.CandidateVersion = checkpoint.CandidateModelVersion
		status, reasons := ClassifyGate(checkpoint, gate)
		decision.GateStatus = status
		decision.Reasons = reasons
		if status == GateStatusPass {
			decision.Action = ActionPromote
			decision.Promoted = true
			decision.ModelVersion = checkpoint.CandidateModelVersion
			result.Decisions = append(result.Decisions, decision)
			result.Registry.Models = append(result.Registry.Models, PromotedModel{
				ObservationWindowS: window,
				ModelVersion:       checkpoint.CandidateModelVersion,
				ModelSetVersion:    report.ModelSetVersion,
				PromotedAt:         now.Format(time.RFC3339),
			})
			continue
		}

		// Fail closed: threshold or missing-evidence failures retain the prior model.
		decision.Action = retainOrSkip(previousModel.ModelVersion)
		decision.ModelVersion = previousModel.ModelVersion
		result.Decisions = append(result.Decisions, decision)
		if previousModel.ModelVersion != "" {
			result.Registry.Models = append(result.Registry.Models, previousModel)
		}
	}

	result.Registry = result.Registry.Normalize()
	return result, nil
}

func retainOrSkip(previousVersion string) string {
	if previousVersion != "" {
		return ActionRetain
	}
	return ActionNoPromotion
}
