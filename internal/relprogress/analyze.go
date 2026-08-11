package relprogress

import (
	"math"
	"strings"
)

// Recommendation is the private v2 decision for relative-progress checkpoints.
type Recommendation string

const (
	RecommendationShip   Recommendation = "ship"
	RecommendationDefer  Recommendation = "defer"
	RecommendationReject Recommendation = "reject"
)

// EvidenceBar is the private bar relative-progress must clear before v2 shipping.
type EvidenceBar struct {
	MinLongBuildRuns            int
	MinUniqueLateSignalRuns     int
	RequireHistoricalCorpus     bool
	MaxShortBuildCollisionNoise float64
	MinLateRiskLift             float64
}

// DefaultEvidenceBar returns the conservative private promotion bar for v2.
func DefaultEvidenceBar() EvidenceBar {
	return EvidenceBar{
		MinLongBuildRuns:            3,
		MinUniqueLateSignalRuns:     2,
		RequireHistoricalCorpus:     true,
		MaxShortBuildCollisionNoise: 0,
		MinLateRiskLift:             1,
	}
}

// RunAssessment captures whether relative candidates add signal for one finished run.
type RunAssessment struct {
	RunID                  string
	FinalDurationS         float64
	LongBuild              bool
	RelativeCandidateCount int
	UniqueLateSignal       bool
	RiskLift               float64
	PeakRSSErrorLift       float64
	DurationErrorLift      float64
	CollisionNoise         bool
	Reasons                []string
}

// AddsSignal reports when relative-progress checkpoints add signal beyond the
// fixed v1 windows for a finished run.
func (a RunAssessment) AddsSignal() bool {
	return a.LongBuild && a.UniqueLateSignal && a.RiskLift >= DefaultEvidenceBar().MinLateRiskLift
}

// StudyReport summarizes the fixture/backtest comparison and v2 recommendation.
type StudyReport struct {
	Source               string
	EvidenceBar          EvidenceBar
	EvidenceBarCleared   bool
	Recommendation       Recommendation
	RecommendationReason string
	LongBuildRuns        int
	UniqueLateSignalRuns int
	ShortBuildRuns       int
	CollisionNoiseRuns   int
	Assessments          []RunAssessment
}

// AssessRun compares fixed-window and relative-progress candidates for one run.
func AssessRun(run FixtureRun, fixed []ScoredCandidate, relative []ScoredCandidate) RunAssessment {
	lastFixedWindow := FixedWindows[len(FixedWindows)-1]
	assessment := RunAssessment{
		RunID:                  run.RunID,
		FinalDurationS:         run.FinalDurationS,
		LongBuild:              run.FinalDurationS > float64(lastFixedWindow),
		RelativeCandidateCount: len(relative),
		Reasons:                make([]string, 0, 4),
	}

	lastFixed := lastReady(fixed)
	bestRelative := bestReady(relative)

	if !assessment.LongBuild {
		assessment.Reasons = append(assessment.Reasons, "duration within fixed v1 coverage")
		if hasNearCollision(relative) {
			assessment.CollisionNoise = true
			assessment.Reasons = append(assessment.Reasons, "relative candidate collides with fixed window")
		}
		return assessment
	}

	if len(relative) == 0 {
		assessment.Reasons = append(assessment.Reasons, "no distinct relative candidates beyond fixed windows")
		return assessment
	}

	if lastFixed.Checkpoint.Status != "ready" || bestRelative.Checkpoint.Status != "ready" {
		assessment.Reasons = append(assessment.Reasons, "missing ready fixed or relative checkpoint")
		return assessment
	}

	fixedRisk := riskRank(lastFixed.Checkpoint.RiskLevel)
	relativeRisk := riskRank(bestRelative.Checkpoint.RiskLevel)
	assessment.RiskLift = float64(relativeRisk - fixedRisk)

	fixedPeakErr := absError(run.FinalPeakRSSMB, lastFixed.Checkpoint.PredictedPeakRSSMB)
	relativePeakErr := absError(run.FinalPeakRSSMB, bestRelative.Checkpoint.PredictedPeakRSSMB)
	assessment.PeakRSSErrorLift = fixedPeakErr - relativePeakErr

	fixedDurErr := absError(run.FinalDurationS, lastFixed.Checkpoint.PredictedDurationS)
	relativeDurErr := absError(run.FinalDurationS, bestRelative.Checkpoint.PredictedDurationS)
	assessment.DurationErrorLift = fixedDurErr - relativeDurErr

	lateRisk := relativeRisk > fixedRisk
	lateAfterFixed := bestRelative.Candidate.ObservationWindowS > lastFixedWindow
	improvedPeak := assessment.PeakRSSErrorLift > 0.02

	// Evidence-bar signal requires a post-20m relative window with raised risk.
	assessment.UniqueLateSignal = lateAfterFixed && lateRisk
	if !assessment.UniqueLateSignal && lateAfterFixed && improvedPeak && assessment.RiskLift == 0 {
		// Keep peak improvement visible in reasons without counting it as the
		// private evidence-bar signal, which is reserved for late risk lift.
		assessment.Reasons = append(assessment.Reasons, "later relative window improves peak estimate without risk lift")
		return assessment
	}

	if assessment.UniqueLateSignal {
		assessment.Reasons = append(assessment.Reasons, "relative candidate after 20m adds distinct late-stage signal")
	} else if lateAfterFixed && assessment.DurationErrorLift > 0 && !lateRisk {
		assessment.Reasons = append(assessment.Reasons, "later relative window only improves duration trivially")
	} else {
		assessment.Reasons = append(assessment.Reasons, "relative candidates do not improve late-stage signal beyond 20m")
	}
	return assessment
}

// DecideRecommendation applies the private evidence bar to study outcomes.
func DecideRecommendation(report StudyReport) StudyReport {
	bar := report.EvidenceBar
	reasons := make([]string, 0, 4)

	cleared := true
	if report.LongBuildRuns < bar.MinLongBuildRuns {
		cleared = false
		reasons = append(reasons, "insufficient long-build cohort")
	}
	if report.UniqueLateSignalRuns < bar.MinUniqueLateSignalRuns {
		cleared = false
		reasons = append(reasons, "unique late-stage signal below bar")
	}
	if report.CollisionNoiseRuns > 0 {
		noiseRate := float64(report.CollisionNoiseRuns) / math.Max(float64(report.ShortBuildRuns), 1)
		if noiseRate > bar.MaxShortBuildCollisionNoise {
			cleared = false
			reasons = append(reasons, "short-build relative collision noise")
		}
	}
	if bar.RequireHistoricalCorpus && strings.EqualFold(report.Source, "fixture") {
		cleared = false
		reasons = append(reasons, "historical corpus backtest not yet available")
	}

	report.EvidenceBarCleared = cleared
	if cleared {
		report.Recommendation = RecommendationShip
		report.RecommendationReason = "relative-progress checkpoints clear the private evidence bar for v2"
		return report
	}

	// Fixture studies that show unique late-stage signal justify deferring, not rejecting.
	if report.UniqueLateSignalRuns > 0 && report.CollisionNoiseRuns == 0 {
		report.Recommendation = RecommendationDefer
		report.RecommendationReason = "prototype shows long-build signal, but " + strings.Join(reasons, "; ")
		return report
	}
	if report.UniqueLateSignalRuns == 0 && report.LongBuildRuns >= bar.MinLongBuildRuns {
		report.Recommendation = RecommendationReject
		report.RecommendationReason = "long-build fixtures show no added signal beyond fixed v1 windows"
		return report
	}

	report.Recommendation = RecommendationDefer
	if len(reasons) == 0 {
		report.RecommendationReason = "evidence incomplete for a v2 ship decision"
	} else {
		report.RecommendationReason = strings.Join(reasons, "; ")
	}
	return report
}

func lastReady(scored []ScoredCandidate) ScoredCandidate {
	var last ScoredCandidate
	for _, item := range scored {
		if item.Candidate.Kind != KindFixed {
			continue
		}
		if item.Checkpoint.Status == "ready" {
			last = item
		}
	}
	return last
}

func bestReady(scored []ScoredCandidate) ScoredCandidate {
	var best ScoredCandidate
	bestRank := -1
	for _, item := range scored {
		if item.Candidate.Kind != KindRelative || item.Checkpoint.Status != "ready" {
			continue
		}
		rank := riskRank(item.Checkpoint.RiskLevel)
		if rank > bestRank || (rank == bestRank && item.Candidate.ObservationWindowS > best.Candidate.ObservationWindowS) {
			best = item
			bestRank = rank
		}
	}
	return best
}

func hasNearCollision(relative []ScoredCandidate) bool {
	for _, item := range relative {
		if nearFixedWindow(item.Candidate.ObservationWindowS, 30) {
			return true
		}
	}
	return false
}

func riskRank(level string) int {
	switch strings.ToLower(level) {
	case "high":
		return 3
	case "elevated":
		return 2
	case "low":
		return 1
	default:
		return 0
	}
}

func absError(actual float64, predicted *float64) float64 {
	if predicted == nil || actual <= 0 {
		return 0
	}
	return math.Abs(actual-*predicted) / actual
}
