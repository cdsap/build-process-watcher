package relprogress

import (
	"math"
	"strings"
)

// Private live-scoring readiness gate statuses.
// Missing or weak evidence fails closed onto fixed-window behavior.
const (
	ReadinessStatusPass                 = "pass"
	ReadinessStatusFail                 = "fail"
	ReadinessStatusInsufficientEvidence = "insufficient_evidence"
)

// Private live-scoring actions after readiness evaluation.
const (
	LiveScoringActionEnableRelative        = "enable_relative"
	LiveScoringActionRetainFixedWindow     = "retain_fixed_window"
	LiveScoringActionRollbackToFixedWindow = "rollback_to_fixed_window"
)

// LiveReadinessBar is the private minimum evidence required before relative-
// progress checkpoints may enter live scoring.
type LiveReadinessBar struct {
	MinLongBuildRuns            int
	MinUniqueLateSignalRuns     int
	MaxShortBuildCollisionNoise float64
	MinImprovedCandidateWindows int
	RequireHistoricalCorpus     bool
}

// DefaultLiveReadinessBar returns the conservative private readiness thresholds.
func DefaultLiveReadinessBar() LiveReadinessBar {
	return LiveReadinessBar{
		MinLongBuildRuns:            3,
		MinUniqueLateSignalRuns:     2,
		MaxShortBuildCollisionNoise: 0,
		MinImprovedCandidateWindows: 1,
		RequireHistoricalCorpus:     true,
	}
}

// LiveReadinessEvidence is private study/quality evidence for the readiness gate.
// Provider diagnostics stay out of public checkpoints and remain optional here.
type LiveReadinessEvidence struct {
	Source                       string
	LongBuildRuns                int
	ShortBuildRuns               int
	UniqueLateSignalRuns         int
	CollisionNoiseRuns           int
	CandidateWindows             int
	SparseCandidateWindows       int
	ImprovedCandidateWindows     int
	PeakRSSRegressedVsFixed      bool
	DurationRegressedVsFixed     bool
	RiskAccuracyRegressedVsFixed bool
	PreviouslyEnabled            bool
	Diagnostics                  []string
}

// LiveReadinessDecision is the private fail-closed readiness outcome.
type LiveReadinessDecision struct {
	Status              string
	Action              string
	LiveRelativeEnabled bool
	Reasons             []string
	// Diagnostics mirrors private provider/ops detail and must not be copied
	// into public PredictionCheckpoint messages.
	Diagnostics []string
}

// EvaluateLiveReadiness returns whether relative-progress may be used in live
// scoring. Missing or weak evidence keeps scoring on fixed windows.
func EvaluateLiveReadiness(evidence LiveReadinessEvidence, bar LiveReadinessBar) LiveReadinessDecision {
	status, reasons := ClassifyLiveReadiness(evidence, bar)
	decision := LiveReadinessDecision{
		Status:      status,
		Reasons:     reasons,
		Diagnostics: append([]string(nil), evidence.Diagnostics...),
	}
	return ApplyLiveReadinessAction(decision, evidence.PreviouslyEnabled)
}

// ClassifyLiveReadiness returns pass, fail, or insufficient_evidence with reasons.
func ClassifyLiveReadiness(evidence LiveReadinessEvidence, bar LiveReadinessBar) (string, []string) {
	if reasons := insufficientEvidenceReasons(evidence, bar); len(reasons) > 0 {
		return ReadinessStatusInsufficientEvidence, reasons
	}
	if reasons := readinessFailureReasons(evidence, bar); len(reasons) > 0 {
		return ReadinessStatusFail, reasons
	}
	return ReadinessStatusPass, nil
}

// ApplyLiveReadinessAction maps a classified status onto enable / retain / rollback.
// Fail and insufficient-evidence both disable relative live scoring (fail closed).
func ApplyLiveReadinessAction(decision LiveReadinessDecision, previouslyEnabled bool) LiveReadinessDecision {
	switch decision.Status {
	case ReadinessStatusPass:
		decision.Action = LiveScoringActionEnableRelative
		decision.LiveRelativeEnabled = true
	case ReadinessStatusFail, ReadinessStatusInsufficientEvidence:
		decision.LiveRelativeEnabled = false
		if previouslyEnabled {
			decision.Action = LiveScoringActionRollbackToFixedWindow
		} else {
			decision.Action = LiveScoringActionRetainFixedWindow
		}
	default:
		decision.LiveRelativeEnabled = false
		if previouslyEnabled {
			decision.Action = LiveScoringActionRollbackToFixedWindow
		} else {
			decision.Action = LiveScoringActionRetainFixedWindow
		}
		if decision.Status == "" {
			decision.Status = ReadinessStatusInsufficientEvidence
		}
		if len(decision.Reasons) == 0 {
			decision.Reasons = []string{"unknown readiness status"}
		}
	}
	return decision
}

// AllowsRelativeLiveScoring reports whether relative-progress windows may be
// scored live. Fixed-window behavior remains the fail-closed default.
func AllowsRelativeLiveScoring(decision LiveReadinessDecision) bool {
	return decision.Status == ReadinessStatusPass && decision.LiveRelativeEnabled
}

// LiveCandidateKinds returns the checkpoint kinds permitted for live scoring.
func LiveCandidateKinds(decision LiveReadinessDecision) []Kind {
	if AllowsRelativeLiveScoring(decision) {
		return []Kind{KindFixed, KindRelative}
	}
	return []Kind{KindFixed}
}

func insufficientEvidenceReasons(evidence LiveReadinessEvidence, bar LiveReadinessBar) []string {
	reasons := make([]string, 0, 5)

	if evidence.CandidateWindows <= 0 {
		reasons = append(reasons, "missing relative-progress candidate evidence")
	}
	if evidence.LongBuildRuns <= 0 {
		reasons = append(reasons, "missing long-build cohort evidence")
	}
	if evidence.CandidateWindows > 0 && evidence.SparseCandidateWindows >= evidence.CandidateWindows {
		reasons = append(reasons, "sparse relative-progress telemetry")
	}
	if bar.RequireHistoricalCorpus && strings.EqualFold(evidence.Source, "fixture") {
		reasons = append(reasons, "historical corpus backtest not yet available")
	}
	if evidence.LongBuildRuns > 0 && evidence.LongBuildRuns < bar.MinLongBuildRuns {
		reasons = append(reasons, "insufficient long-build cohort")
	}
	if evidence.UniqueLateSignalRuns > 0 && evidence.UniqueLateSignalRuns < bar.MinUniqueLateSignalRuns {
		reasons = append(reasons, "unique late-stage signal below readiness bar")
	}
	if evidence.ImprovedCandidateWindows > 0 && evidence.ImprovedCandidateWindows < bar.MinImprovedCandidateWindows {
		reasons = append(reasons, "improved relative-progress windows below readiness bar")
	}

	return reasons
}

func readinessFailureReasons(evidence LiveReadinessEvidence, bar LiveReadinessBar) []string {
	reasons := make([]string, 0, 6)

	if evidence.CollisionNoiseRuns > 0 {
		noiseRate := float64(evidence.CollisionNoiseRuns) / math.Max(float64(evidence.ShortBuildRuns), 1)
		if noiseRate > bar.MaxShortBuildCollisionNoise {
			reasons = append(reasons, "short-build relative collision noise")
		}
	}
	if evidence.LongBuildRuns >= bar.MinLongBuildRuns && evidence.UniqueLateSignalRuns == 0 {
		reasons = append(reasons, "long-build cohort shows no unique late-stage signal")
	}
	if evidence.CandidateWindows > 0 &&
		evidence.SparseCandidateWindows < evidence.CandidateWindows &&
		evidence.ImprovedCandidateWindows < bar.MinImprovedCandidateWindows {
		reasons = append(reasons, "relative-progress candidates do not improve on fixed windows")
	}
	if evidence.PeakRSSRegressedVsFixed {
		reasons = append(reasons, "peak rss worse than fixed-window baseline")
	}
	if evidence.DurationRegressedVsFixed {
		reasons = append(reasons, "duration worse than fixed-window baseline")
	}
	if evidence.RiskAccuracyRegressedVsFixed {
		reasons = append(reasons, "risk calibration worse than fixed-window baseline")
	}

	return reasons
}
