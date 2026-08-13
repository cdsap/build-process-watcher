package quality

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"sort"
)

const defaultMinCohort = 3

// LoadDatasetFile reads a private finished-run evaluation fixture.
func LoadDatasetFile(path string) (Dataset, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return Dataset{}, err
	}
	var dataset Dataset
	if err := json.Unmarshal(body, &dataset); err != nil {
		return Dataset{}, err
	}
	return dataset, nil
}

// Evaluate aggregates finished-run checkpoint outcomes into a private quality report.
func Evaluate(dataset Dataset) (Report, error) {
	if dataset.ModelSetVersion == "" {
		return Report{}, fmt.Errorf("model_set_version is required")
	}
	minCohort := dataset.MinCohort
	if minCohort <= 0 {
		minCohort = defaultMinCohort
	}

	byWindow := make(map[int][]CheckpointObservation, len(CheckpointWindows))
	for _, run := range dataset.Runs {
		seen := make(map[int]struct{}, len(run.Checkpoints))
		for _, observation := range run.Checkpoints {
			if observation.ObservationWindowS <= 0 {
				return Report{}, fmt.Errorf("dataset contains invalid observation_window_s")
			}
			if _, exists := seen[observation.ObservationWindowS]; exists {
				return Report{}, fmt.Errorf("run duplicates observation_window_s %d", observation.ObservationWindowS)
			}
			seen[observation.ObservationWindowS] = struct{}{}
			byWindow[observation.ObservationWindowS] = append(byWindow[observation.ObservationWindowS], observation)
		}
		seenRelative := make(map[int]struct{}, len(run.RelativeProgressCandidates))
		for _, observation := range run.RelativeProgressCandidates {
			if observation.ObservationWindowS <= 0 {
				return Report{}, fmt.Errorf("dataset contains invalid relative-progress observation_window_s")
			}
			if _, exists := seenRelative[observation.ObservationWindowS]; exists {
				return Report{}, fmt.Errorf("run duplicates relative-progress observation_window_s %d", observation.ObservationWindowS)
			}
			seenRelative[observation.ObservationWindowS] = struct{}{}
		}
	}

	report := Report{
		ModelSetVersion: dataset.ModelSetVersion,
		Checkpoints:     make([]CheckpointQuality, 0, len(CheckpointWindows)),
	}
	for _, window := range CheckpointWindows {
		checkpoint := evaluateWindow(window, byWindow[window], minCohort)
		checkpoint.EvaluationRole = EvaluationRoleLive
		report.Checkpoints = append(report.Checkpoints, checkpoint)
	}
	report.RelativeProgress = evaluateRelativeProgress(dataset.Runs, minCohort)
	return report, nil
}

func evaluateWindow(window int, observations []CheckpointObservation, minCohort int) CheckpointQuality {
	result := CheckpointQuality{
		ObservationWindowS: window,
		CohortSize:         len(observations),
		Notes:              make([]string, 0, 3),
	}
	if len(observations) == 0 {
		result.Sparse = true
		result.Notes = append(result.Notes, "sparse checkpoint coverage")
		result.Notes = append(result.Notes, "no promotable candidate model")
		return result
	}

	result.PeakRSSMAPE = roundFour(meanAbsolutePercentageError(observations, func(item CheckpointObservation) (float64, float64) {
		return item.ActualPeakRSSMB, item.PredictedPeakRSSMB
	}))
	result.DurationMAPE = roundFour(meanAbsolutePercentageError(observations, func(item CheckpointObservation) (float64, float64) {
		return item.ActualDurationS, item.PredictedDurationS
	}))
	result.RiskAccuracyRate = roundFour(riskAccuracy(observations, func(item CheckpointObservation) (string, string) {
		return item.ActualRisk, item.PredictedRisk
	}))
	result.BaselinePeakRSSMAPE = roundFour(meanAbsolutePercentageError(observations, func(item CheckpointObservation) (float64, float64) {
		return item.ActualPeakRSSMB, item.BaselinePeakRSSMB
	}))
	result.BaselineDurationMAPE = roundFour(meanAbsolutePercentageError(observations, func(item CheckpointObservation) (float64, float64) {
		return item.ActualDurationS, item.BaselineDurationS
	}))
	result.BaselineRiskAccuracyRate = roundFour(riskAccuracy(observations, func(item CheckpointObservation) (string, string) {
		return item.ActualRisk, item.BaselineRisk
	}))

	result.CandidateModelVersion = candidateModelVersion(observations)
	if result.CohortSize < minCohort {
		result.Sparse = true
		result.Notes = append(result.Notes, "sparse checkpoint coverage")
	}
	if result.CandidateModelVersion == "" {
		result.Notes = append(result.Notes, "no promotable candidate model")
	}
	if result.BaselinePeakRSSMAPE > 0 || result.BaselineDurationMAPE > 0 || result.BaselineRiskAccuracyRate > 0 {
		result.Notes = append(result.Notes, baselineComparisonNote(result))
	}
	return result
}

type pairedRelativeObservation struct {
	relative            CheckpointObservation
	comparedFixedWindow int
	fixedPeakRSSMB      float64
	fixedDurationS      float64
	fixedRisk           string
	hasFixed            bool
}

func evaluateRelativeProgress(runs []FinishedRun, minCohort int) RelativeProgressQuality {
	result := RelativeProgressQuality{
		EvaluationRole:           EvaluationRoleAdvisory,
		LiveFixedWindowsRetained: true,
		Candidates:               make([]RelativeCandidateQuality, 0),
		Notes:                    make([]string, 0, 3),
	}

	byWindow := make(map[int][]pairedRelativeObservation)
	for _, run := range runs {
		lastFixed, hasFixed := lastFixedCheckpoint(run.Checkpoints)
		for _, observation := range run.RelativeProgressCandidates {
			pair := pairedRelativeObservation{relative: observation}
			if hasFixed {
				pair.hasFixed = true
				pair.comparedFixedWindow = lastFixed.ObservationWindowS
				pair.fixedPeakRSSMB = lastFixed.PredictedPeakRSSMB
				pair.fixedDurationS = lastFixed.PredictedDurationS
				pair.fixedRisk = lastFixed.PredictedRisk
			}
			byWindow[observation.ObservationWindowS] = append(byWindow[observation.ObservationWindowS], pair)
		}
	}

	if len(byWindow) == 0 {
		result.Notes = append(result.Notes, "no relative-progress candidates")
		return result
	}

	windows := make([]int, 0, len(byWindow))
	for window := range byWindow {
		windows = append(windows, window)
	}
	sort.Ints(windows)

	for _, window := range windows {
		candidate := evaluateRelativeCandidate(window, byWindow[window], minCohort)
		result.Candidates = append(result.Candidates, candidate)
		result.CandidateWindows++
		if candidate.Sparse {
			result.SparseCandidateWindows++
		}
		if candidate.ImprovedVsFixed || candidate.ImprovedVsBaseline {
			result.ImprovedCandidateWindows++
		}
	}

	switch {
	case result.CandidateWindows == 0:
		result.Notes = append(result.Notes, "no relative-progress candidates")
	case result.SparseCandidateWindows == result.CandidateWindows:
		result.Notes = append(result.Notes, "relative-progress candidate coverage is sparse")
	case result.ImprovedCandidateWindows > 0:
		result.Notes = append(result.Notes, "relative-progress candidates improve on fixed-window or baseline quality")
	default:
		result.Notes = append(result.Notes, "relative-progress candidates reviewed without live promotion")
	}
	return result
}

func evaluateRelativeCandidate(window int, pairs []pairedRelativeObservation, minCohort int) RelativeCandidateQuality {
	observations := make([]CheckpointObservation, 0, len(pairs))
	for _, pair := range pairs {
		observations = append(observations, pair.relative)
	}

	result := RelativeCandidateQuality{
		ObservationWindowS: window,
		EvaluationRole:     EvaluationRoleAdvisory,
		CohortSize:         len(observations),
		Notes:              make([]string, 0, 4),
	}
	if len(observations) == 0 {
		result.Sparse = true
		result.Notes = append(result.Notes, "sparse relative-progress candidate coverage")
		result.Notes = append(result.Notes, "no relative-progress candidate model")
		return result
	}

	result.PeakRSSMAPE = roundFour(meanAbsolutePercentageError(observations, func(item CheckpointObservation) (float64, float64) {
		return item.ActualPeakRSSMB, item.PredictedPeakRSSMB
	}))
	result.DurationMAPE = roundFour(meanAbsolutePercentageError(observations, func(item CheckpointObservation) (float64, float64) {
		return item.ActualDurationS, item.PredictedDurationS
	}))
	result.RiskAccuracyRate = roundFour(riskAccuracy(observations, func(item CheckpointObservation) (string, string) {
		return item.ActualRisk, item.PredictedRisk
	}))
	result.BaselinePeakRSSMAPE = roundFour(meanAbsolutePercentageError(observations, func(item CheckpointObservation) (float64, float64) {
		return item.ActualPeakRSSMB, item.BaselinePeakRSSMB
	}))
	result.BaselineDurationMAPE = roundFour(meanAbsolutePercentageError(observations, func(item CheckpointObservation) (float64, float64) {
		return item.ActualDurationS, item.BaselineDurationS
	}))
	result.BaselineRiskAccuracyRate = roundFour(riskAccuracy(observations, func(item CheckpointObservation) (string, string) {
		return item.ActualRisk, item.BaselineRisk
	}))
	result.CandidateModelVersion = candidateModelVersion(observations)

	fixedPairs := make([]pairedRelativeObservation, 0, len(pairs))
	comparedWindows := make(map[int]struct{})
	for _, pair := range pairs {
		if !pair.hasFixed {
			continue
		}
		fixedPairs = append(fixedPairs, pair)
		comparedWindows[pair.comparedFixedWindow] = struct{}{}
	}
	if len(fixedPairs) > 0 {
		if len(comparedWindows) == 1 {
			for window := range comparedWindows {
				result.ComparedFixedWindowS = window
			}
		}
		result.FixedPeakRSSMAPE = roundFour(meanAbsolutePercentageErrorFromPairs(fixedPairs, func(pair pairedRelativeObservation) (float64, float64) {
			return pair.relative.ActualPeakRSSMB, pair.fixedPeakRSSMB
		}))
		result.FixedDurationMAPE = roundFour(meanAbsolutePercentageErrorFromPairs(fixedPairs, func(pair pairedRelativeObservation) (float64, float64) {
			return pair.relative.ActualDurationS, pair.fixedDurationS
		}))
		result.FixedRiskAccuracyRate = roundFour(riskAccuracyFromPairs(fixedPairs, func(pair pairedRelativeObservation) (string, string) {
			return pair.relative.ActualRisk, pair.fixedRisk
		}))
		result.ImprovedVsFixed = relativeImproves(result.PeakRSSMAPE, result.FixedPeakRSSMAPE, result.DurationMAPE, result.FixedDurationMAPE, result.RiskAccuracyRate, result.FixedRiskAccuracyRate)
		if result.ImprovedVsFixed {
			result.Notes = append(result.Notes, "relative-progress candidate improves on compared fixed-window checkpoint")
		} else {
			result.Notes = append(result.Notes, "relative-progress candidate does not improve on compared fixed-window checkpoint")
		}
		if len(comparedWindows) > 1 {
			result.Notes = append(result.Notes, "compared fixed-window checkpoints vary across runs")
		}
	} else {
		result.Notes = append(result.Notes, "no fixed-window checkpoint available for comparison")
	}

	result.ImprovedVsBaseline = relativeImproves(result.PeakRSSMAPE, result.BaselinePeakRSSMAPE, result.DurationMAPE, result.BaselineDurationMAPE, result.RiskAccuracyRate, result.BaselineRiskAccuracyRate)
	if result.BaselinePeakRSSMAPE > 0 || result.BaselineDurationMAPE > 0 || result.BaselineRiskAccuracyRate > 0 {
		if result.ImprovedVsBaseline {
			result.Notes = append(result.Notes, "relative-progress candidate outperforms simple baseline on aggregate metrics")
		} else if relativeWorsens(result.PeakRSSMAPE, result.BaselinePeakRSSMAPE, result.DurationMAPE, result.BaselineDurationMAPE, result.RiskAccuracyRate, result.BaselineRiskAccuracyRate) {
			result.Notes = append(result.Notes, "relative-progress candidate underperforms simple baseline on aggregate metrics")
		} else {
			result.Notes = append(result.Notes, "relative-progress candidate is mixed versus simple baseline")
		}
	}

	if result.CohortSize < minCohort {
		result.Sparse = true
		result.Notes = append(result.Notes, "sparse relative-progress candidate coverage")
	}
	if result.CandidateModelVersion == "" {
		result.Notes = append(result.Notes, "no relative-progress candidate model")
	}
	return result
}

func lastFixedCheckpoint(checkpoints []CheckpointObservation) (CheckpointObservation, bool) {
	var last CheckpointObservation
	found := false
	for _, observation := range checkpoints {
		if !isLiveFixedWindow(observation.ObservationWindowS) {
			continue
		}
		if !found || observation.ObservationWindowS > last.ObservationWindowS {
			last = observation
			found = true
		}
	}
	return last, found
}

func isLiveFixedWindow(window int) bool {
	for _, fixed := range CheckpointWindows {
		if fixed == window {
			return true
		}
	}
	return false
}

func relativeImproves(peak, peakRef, duration, durationRef, risk, riskRef float64) bool {
	better := 0
	worse := 0
	if peak < peakRef {
		better++
	} else if peak > peakRef {
		worse++
	}
	if duration < durationRef {
		better++
	} else if duration > durationRef {
		worse++
	}
	if risk > riskRef {
		better++
	} else if risk < riskRef {
		worse++
	}
	return better > worse
}

func relativeWorsens(peak, peakRef, duration, durationRef, risk, riskRef float64) bool {
	better := 0
	worse := 0
	if peak < peakRef {
		better++
	} else if peak > peakRef {
		worse++
	}
	if duration < durationRef {
		better++
	} else if duration > durationRef {
		worse++
	}
	if risk > riskRef {
		better++
	} else if risk < riskRef {
		worse++
	}
	return worse > better
}

func meanAbsolutePercentageErrorFromPairs(pairs []pairedRelativeObservation, values func(pairedRelativeObservation) (actual, predicted float64)) float64 {
	if len(pairs) == 0 {
		return 0
	}
	total := 0.0
	count := 0
	for _, item := range pairs {
		actual, predicted := values(item)
		if actual <= 0 {
			continue
		}
		total += math.Abs(actual-predicted) / actual
		count++
	}
	if count == 0 {
		return 0
	}
	return total / float64(count)
}

func riskAccuracyFromPairs(pairs []pairedRelativeObservation, values func(pairedRelativeObservation) (actual, predicted string)) float64 {
	if len(pairs) == 0 {
		return 0
	}
	matches := 0
	scored := 0
	for _, item := range pairs {
		actual, predicted := values(item)
		actual = normalizeRisk(actual)
		predicted = normalizeRisk(predicted)
		if actual == "unknown" {
			continue
		}
		scored++
		if actual == predicted {
			matches++
		}
	}
	if scored == 0 {
		return 0
	}
	return float64(matches) / float64(scored)
}

func candidateModelVersion(observations []CheckpointObservation) string {
	versions := make(map[string]struct{}, len(observations))
	for _, observation := range observations {
		if observation.CandidateModelVersion == "" {
			continue
		}
		versions[observation.CandidateModelVersion] = struct{}{}
	}
	if len(versions) != 1 {
		return ""
	}
	for version := range versions {
		return version
	}
	return ""
}

func baselineComparisonNote(checkpoint CheckpointQuality) string {
	better := 0
	worse := 0
	if checkpoint.PeakRSSMAPE < checkpoint.BaselinePeakRSSMAPE {
		better++
	} else if checkpoint.PeakRSSMAPE > checkpoint.BaselinePeakRSSMAPE {
		worse++
	}
	if checkpoint.DurationMAPE < checkpoint.BaselineDurationMAPE {
		better++
	} else if checkpoint.DurationMAPE > checkpoint.BaselineDurationMAPE {
		worse++
	}
	if checkpoint.RiskAccuracyRate > checkpoint.BaselineRiskAccuracyRate {
		better++
	} else if checkpoint.RiskAccuracyRate < checkpoint.BaselineRiskAccuracyRate {
		worse++
	}
	switch {
	case better > worse:
		return "current model outperforms simple baseline on aggregate metrics"
	case worse > better:
		return "current model underperforms simple baseline on aggregate metrics"
	default:
		return "current model is mixed versus simple baseline"
	}
}

func meanAbsolutePercentageError(observations []CheckpointObservation, values func(CheckpointObservation) (actual, predicted float64)) float64 {
	if len(observations) == 0 {
		return 0
	}
	total := 0.0
	count := 0
	for _, item := range observations {
		actual, predicted := values(item)
		if actual <= 0 {
			continue
		}
		total += math.Abs(actual-predicted) / actual
		count++
	}
	if count == 0 {
		return 0
	}
	return total / float64(count)
}

func riskAccuracy(observations []CheckpointObservation, values func(CheckpointObservation) (actual, predicted string)) float64 {
	if len(observations) == 0 {
		return 0
	}
	matches := 0
	scored := 0
	for _, item := range observations {
		actual, predicted := values(item)
		actual = normalizeRisk(actual)
		predicted = normalizeRisk(predicted)
		if actual == "unknown" {
			continue
		}
		scored++
		if actual == predicted {
			matches++
		}
	}
	if scored == 0 {
		return 0
	}
	return float64(matches) / float64(scored)
}

func normalizeRisk(value string) string {
	switch value {
	case "high", "elevated", "low":
		return value
	default:
		return "unknown"
	}
}

func roundFour(value float64) float64 {
	return math.Round(value*10000) / 10000
}

// SaveReportJSON writes the private quality report JSON artifact.
func SaveReportJSON(path string, report Report) error {
	body, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return err
	}
	body = append(body, '\n')
	return os.WriteFile(path, body, 0o644)
}

// CheckpointByWindow indexes report checkpoints for tests and callers.
func CheckpointByWindow(report Report) map[int]CheckpointQuality {
	byWindow := make(map[int]CheckpointQuality, len(report.Checkpoints))
	for _, checkpoint := range report.Checkpoints {
		byWindow[checkpoint.ObservationWindowS] = checkpoint
	}
	return byWindow
}
