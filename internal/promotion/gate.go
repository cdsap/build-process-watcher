package promotion

// EvaluateGate returns whether a checkpoint quality snapshot passes promotion.
func EvaluateGate(checkpoint CheckpointQuality, gate Gate) (bool, []string) {
	reasons := make([]string, 0, 6)

	if checkpoint.Sparse {
		reasons = append(reasons, "sparse checkpoint coverage")
	}
	if checkpoint.CohortSize < gate.MinCohort {
		reasons = append(reasons, "insufficient checkpoint cohort")
	}
	if checkpoint.CandidateModelVersion == "" {
		reasons = append(reasons, "missing candidate model version")
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

	return len(reasons) == 0, reasons
}
