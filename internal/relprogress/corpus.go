package relprogress

import (
	"math"
	"sort"
	"strings"
)

// Private finished-run corpus cohorts used for relative-progress evaluation.
// Duration cohorts are mutually exclusive; sparse/incomplete are orthogonal flags.
const (
	CohortShort      = "short"
	CohortMedium     = "medium"
	CohortLong       = "long"
	CohortSparse     = "sparse"
	CohortIncomplete = "incomplete"
)

// Duration cohort boundaries stay aligned with v1 fixed windows without
// publishing threshold formulas in report text.
const (
	shortDurationMaxS  = 600  // through 10m fixed window
	mediumDurationMaxS = 1200 // through 20m fixed window
)

// CohortMetrics summarizes fixed-window versus relative-progress quality for one cohort.
type CohortMetrics struct {
	Name                   string   `json:"name"`
	RunCount               int      `json:"run_count"`
	CoverageReadyRuns      int      `json:"coverage_ready_runs"`
	SparseDataCases        int      `json:"sparse_data_cases"`
	IncompleteCases        int      `json:"incomplete_cases"`
	FixedPeakRSSMAPE       float64  `json:"fixed_peak_rss_mape"`
	RelativePeakRSSMAPE    float64  `json:"relative_peak_rss_mape"`
	FixedDurationMAPE      float64  `json:"fixed_duration_mape"`
	RelativeDurationMAPE   float64  `json:"relative_duration_mape"`
	FixedRiskAccuracyRate  float64  `json:"fixed_risk_accuracy_rate"`
	RelativeRiskAccuracy   float64  `json:"relative_risk_accuracy_rate"`
	ImprovedVsFixed        bool     `json:"improved_vs_fixed"`
	UniqueLateSignalRuns   int      `json:"unique_late_signal_runs"`
	Notes                  []string `json:"notes,omitempty"`
}

// ClassifyRun assigns duration and quality cohorts for one finished run.
func ClassifyRun(run FixtureRun) (durationCohort string, sparse bool, incomplete bool) {
	switch {
	case run.FinalDurationS <= shortDurationMaxS:
		durationCohort = CohortShort
	case run.FinalDurationS <= mediumDurationMaxS:
		durationCohort = CohortMedium
	default:
		durationCohort = CohortLong
	}

	maxElapsed := 0
	for _, sample := range run.Samples {
		if sample.ElapsedTime > maxElapsed {
			maxElapsed = sample.ElapsedTime
		}
	}
	if run.FinalDurationS > 0 {
		incompleteCutoff := int(math.Floor(run.FinalDurationS * 0.85))
		if maxElapsed < incompleteCutoff {
			incomplete = true
		}
	}
	if len(run.Samples) == 0 {
		incomplete = true
		sparse = true
		return durationCohort, sparse, incomplete
	}

	// Sparse: too few samples to cover the finished shape, independent of duration cohort.
	minSamples := 3
	if run.FinalDurationS > float64(mediumDurationMaxS) {
		minSamples = 4
	}
	if len(run.Samples) < minSamples {
		sparse = true
	}
	return durationCohort, sparse, incomplete
}

// RunCohorts returns the ordered cohort labels that apply to a finished run.
func RunCohorts(run FixtureRun) []string {
	duration, sparse, incomplete := ClassifyRun(run)
	labels := []string{duration}
	if sparse {
		labels = append(labels, CohortSparse)
	}
	if incomplete {
		labels = append(labels, CohortIncomplete)
	}
	return labels
}

// AggregateCohorts builds per-cohort coverage/error/risk summaries from run assessments.
func AggregateCohorts(assessments []RunAssessment) []CohortMetrics {
	order := []string{CohortShort, CohortMedium, CohortLong, CohortSparse, CohortIncomplete}
	buckets := make(map[string][]RunAssessment, len(order))
	for _, name := range order {
		buckets[name] = nil
	}
	for _, assessment := range assessments {
		for _, label := range assessment.Cohorts {
			buckets[label] = append(buckets[label], assessment)
		}
	}

	metrics := make([]CohortMetrics, 0, len(order))
	for _, name := range order {
		metrics = append(metrics, summarizeCohort(name, buckets[name]))
	}
	return metrics
}

func summarizeCohort(name string, assessments []RunAssessment) CohortMetrics {
	result := CohortMetrics{
		Name:     name,
		RunCount: len(assessments),
		Notes:    make([]string, 0, 3),
	}
	if len(assessments) == 0 {
		result.Notes = append(result.Notes, "no finished runs in cohort")
		return result
	}

	var fixedPeak, relativePeak, fixedDur, relativeDur float64
	var fixedPeakN, relativePeakN, fixedDurN, relativeDurN int
	var fixedRiskHits, fixedRiskN, relativeRiskHits, relativeRiskN int

	for _, assessment := range assessments {
		if assessment.SparseData {
			result.SparseDataCases++
		}
		if assessment.Incomplete {
			result.IncompleteCases++
		}
		if assessment.UniqueLateSignal {
			result.UniqueLateSignalRuns++
		}
		if assessment.HasFixedReady || assessment.HasRelativeReady {
			result.CoverageReadyRuns++
		}
		if assessment.HasFixedReady {
			if assessment.FixedPeakRSSMAPE > 0 || assessment.FinalPeakRSSMB > 0 {
				fixedPeak += assessment.FixedPeakRSSMAPE
				fixedPeakN++
			}
			if assessment.FixedDurationMAPE > 0 || assessment.FinalDurationS > 0 {
				fixedDur += assessment.FixedDurationMAPE
				fixedDurN++
			}
			if assessment.AdvisoryRisk != "" {
				fixedRiskN++
				if assessment.FixedRiskMatch {
					fixedRiskHits++
				}
			}
		}
		if assessment.HasRelativeReady {
			if assessment.RelativePeakRSSMAPE > 0 || assessment.FinalPeakRSSMB > 0 {
				relativePeak += assessment.RelativePeakRSSMAPE
				relativePeakN++
			}
			if assessment.RelativeDurationMAPE > 0 || assessment.FinalDurationS > 0 {
				relativeDur += assessment.RelativeDurationMAPE
				relativeDurN++
			}
			if assessment.AdvisoryRisk != "" {
				relativeRiskN++
				if assessment.RelativeRiskMatch {
					relativeRiskHits++
				}
			}
		}
	}

	result.FixedPeakRSSMAPE = roundFour(meanOrZero(fixedPeak, fixedPeakN))
	result.RelativePeakRSSMAPE = roundFour(meanOrZero(relativePeak, relativePeakN))
	result.FixedDurationMAPE = roundFour(meanOrZero(fixedDur, fixedDurN))
	result.RelativeDurationMAPE = roundFour(meanOrZero(relativeDur, relativeDurN))
	result.FixedRiskAccuracyRate = roundFour(rateOrZero(fixedRiskHits, fixedRiskN))
	result.RelativeRiskAccuracy = roundFour(rateOrZero(relativeRiskHits, relativeRiskN))
	result.ImprovedVsFixed = cohortImproves(result)

	switch {
	case result.CoverageReadyRuns == 0:
		result.Notes = append(result.Notes, "sparse-data or incomplete coverage prevents ready checkpoint comparison")
	case result.ImprovedVsFixed:
		result.Notes = append(result.Notes, "relative-progress checkpoints improve on fixed windows in this cohort")
	default:
		result.Notes = append(result.Notes, "relative-progress checkpoints do not improve on fixed windows in this cohort")
	}
	if result.SparseDataCases > 0 {
		result.Notes = append(result.Notes, "sparse-data cases present")
	}
	if result.IncompleteCases > 0 {
		result.Notes = append(result.Notes, "incomplete runs present")
	}
	return result
}

func cohortImproves(metrics CohortMetrics) bool {
	if metrics.CoverageReadyRuns == 0 {
		return false
	}
	better := 0
	worse := 0
	if metrics.RelativePeakRSSMAPE < metrics.FixedPeakRSSMAPE {
		better++
	} else if metrics.RelativePeakRSSMAPE > metrics.FixedPeakRSSMAPE {
		worse++
	}
	if metrics.RelativeDurationMAPE < metrics.FixedDurationMAPE {
		better++
	} else if metrics.RelativeDurationMAPE > metrics.FixedDurationMAPE {
		worse++
	}
	if metrics.RelativeRiskAccuracy > metrics.FixedRiskAccuracyRate {
		better++
	} else if metrics.RelativeRiskAccuracy < metrics.FixedRiskAccuracyRate {
		worse++
	}
	return better > worse
}

// SummarizeCorpusImprovement decides whether relative-progress improves overall.
func SummarizeCorpusImprovement(report StudyReport) StudyReport {
	long := CohortMetrics{}
	for _, cohort := range report.Cohorts {
		if cohort.Name == CohortLong {
			long = cohort
			break
		}
	}

	switch {
	case long.RunCount == 0:
		report.RelativeImprovesOverFixed = false
		report.ImprovementReason = "no long-build cohort available for relative-progress comparison"
	case long.ImprovedVsFixed && report.UniqueLateSignalRuns > 0:
		report.RelativeImprovesOverFixed = true
		report.ImprovementReason = "long-build corpus shows relative-progress checkpoints improve over fixed windows"
	case report.UniqueLateSignalRuns > 0:
		report.RelativeImprovesOverFixed = true
		report.ImprovementReason = "long-build corpus shows unique late-stage relative-progress signal beyond fixed windows"
	default:
		report.RelativeImprovesOverFixed = false
		report.ImprovementReason = "finished-run corpus does not show relative-progress improvement over fixed windows"
	}
	return report
}

// IsHistoricalCorpusSource reports whether the study input clears the fixture-only bar.
func IsHistoricalCorpusSource(source string) bool {
	normalized := strings.ToLower(strings.TrimSpace(source))
	switch normalized {
	case "historical", "corpus", "finished-run", "finished_run":
		return true
	default:
		return !strings.EqualFold(normalized, "fixture") && normalized != ""
	}
}

func meanOrZero(total float64, count int) float64 {
	if count == 0 {
		return 0
	}
	return total / float64(count)
}

func rateOrZero(hits, count int) float64 {
	if count == 0 {
		return 0
	}
	return float64(hits) / float64(count)
}

func roundFour(value float64) float64 {
	return math.Round(value*10000) / 10000
}

// CohortNames returns the stable cohort order for tests and callers.
func CohortNames() []string {
	names := []string{CohortShort, CohortMedium, CohortLong, CohortSparse, CohortIncomplete}
	return append([]string(nil), names...)
}

// SortCohortMetrics sorts metrics into the stable private cohort order.
func SortCohortMetrics(metrics []CohortMetrics) []CohortMetrics {
	order := map[string]int{}
	for i, name := range CohortNames() {
		order[name] = i
	}
	out := append([]CohortMetrics(nil), metrics...)
	sort.SliceStable(out, func(i, j int) bool {
		return order[out[i].Name] < order[out[j].Name]
	})
	return out
}
