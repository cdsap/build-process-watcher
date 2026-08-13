package promotion

import "math"

const (
	GateStatusPass            = "pass"
	GateStatusFail            = "fail"
	GateStatusMissingEvidence = "missing_evidence"
)

// EvaluateGate returns whether a checkpoint quality snapshot passes promotion.
// Missing evaluation evidence fails closed (never promotes).
func EvaluateGate(checkpoint CheckpointQuality, gate Gate) (bool, []string) {
	status, reasons := ClassifyGate(checkpoint, gate)
	return status == GateStatusPass, reasons
}

// ClassifyGate returns the private gate state for one checkpoint window.
// States are pass, fail (below threshold / sparse / baseline regression),
// or missing_evidence (required evaluation inputs absent or non-finite).
func ClassifyGate(checkpoint CheckpointQuality, gate Gate) (string, []string) {
	if reasons := missingEvidenceReasons(checkpoint); len(reasons) > 0 {
		return GateStatusMissingEvidence, reasons
	}
	if reasons := thresholdFailureReasons(checkpoint, gate); len(reasons) > 0 {
		return GateStatusFail, reasons
	}
	return GateStatusPass, nil
}

func missingEvidenceReasons(checkpoint CheckpointQuality) []string {
	reasons := make([]string, 0, 5)
	if checkpoint.CohortSize <= 0 {
		reasons = append(reasons, "missing evaluation cohort")
	}
	if checkpoint.CandidateModelVersion == "" {
		reasons = append(reasons, "missing candidate model version")
	}
	if !finiteMetric(checkpoint.PeakRSSMAPE) {
		reasons = append(reasons, "missing peak rss mape evidence")
	}
	if !finiteMetric(checkpoint.DurationMAPE) {
		reasons = append(reasons, "missing duration mape evidence")
	}
	if !finiteMetric(checkpoint.RiskAccuracyRate) {
		reasons = append(reasons, "missing risk accuracy evidence")
	}
	return reasons
}

func thresholdFailureReasons(checkpoint CheckpointQuality, gate Gate) []string {
	reasons := make([]string, 0, 6)

	if checkpoint.Sparse {
		reasons = append(reasons, "sparse checkpoint coverage")
	}
	if checkpoint.CohortSize < gate.MinCohort {
		reasons = append(reasons, "insufficient checkpoint cohort")
	}
	if checkpoint.PeakRSSMAPE > gate.MaxPeakRSSMAPE {
		reasons = append(reasons, "peak rss error above gate")
	}
	if checkpoint.DurationMAPE > gate.MaxDurationMAPE {
		reasons = append(reasons, "duration error above gate")
	}
	if checkpoint.RiskAccuracyRate < gate.MinRiskAccuracyRate {
		reasons = append(reasons, "risk calibration below gate")
	}
	if checkpoint.BaselinePeakRSSMAPE > 0 && checkpoint.PeakRSSMAPE > checkpoint.BaselinePeakRSSMAPE {
		reasons = append(reasons, "peak rss worse than baseline")
	}
	if checkpoint.BaselineDurationMAPE > 0 && checkpoint.DurationMAPE > checkpoint.BaselineDurationMAPE {
		reasons = append(reasons, "duration worse than baseline")
	}
	if checkpoint.BaselineRiskAccuracyRate > 0 && checkpoint.RiskAccuracyRate < checkpoint.BaselineRiskAccuracyRate {
		reasons = append(reasons, "risk calibration worse than baseline")
	}

	return reasons
}

func finiteMetric(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0)
}
