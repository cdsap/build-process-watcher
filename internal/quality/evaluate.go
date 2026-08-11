package quality

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
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
	}

	report := Report{
		ModelSetVersion: dataset.ModelSetVersion,
		Checkpoints:     make([]CheckpointQuality, 0, len(CheckpointWindows)),
	}
	for _, window := range CheckpointWindows {
		report.Checkpoints = append(report.Checkpoints, evaluateWindow(window, byWindow[window], minCohort))
	}
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
