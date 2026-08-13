package quality

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"strings"

	"github.com/cdsap/build-process-watcher-predictive-provider/internal/telemetry"
)

// LoadPredictionDatasetFile reads a private prediction-attempt fixture or export.
func LoadPredictionDatasetFile(path string) (PredictionDataset, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return PredictionDataset{}, err
	}
	var dataset PredictionDataset
	if err := json.Unmarshal(body, &dataset); err != nil {
		return PredictionDataset{}, err
	}
	return dataset, nil
}

// EvaluatePredictions aggregates prediction attempts into a private health report.
func EvaluatePredictions(dataset PredictionDataset) (PredictionReport, error) {
	byWindow := make(map[int][]PredictionRecord, len(CheckpointWindows))
	for _, record := range dataset.Predictions {
		if record.ObservationWindowS <= 0 {
			return PredictionReport{}, fmt.Errorf("dataset contains invalid observation_window_s")
		}
		byWindow[record.ObservationWindowS] = append(byWindow[record.ObservationWindowS], record)
	}

	report := PredictionReport{
		Period:      dataset.Period,
		Checkpoints: make([]WindowPredictionQuality, 0, len(CheckpointWindows)),
	}
	for _, window := range CheckpointWindows {
		report.Checkpoints = append(report.Checkpoints, evaluatePredictionWindow(window, byWindow[window]))
	}
	return report, nil
}

func evaluatePredictionWindow(window int, records []PredictionRecord) WindowPredictionQuality {
	result := WindowPredictionQuality{
		ObservationWindowS: window,
		PredictionVolume:   len(records),
		Notes:              make([]string, 0, 4),
	}
	if len(records) == 0 {
		result.Notes = append(result.Notes, "no predictions in window")
		return result
	}

	var labeledRisk []struct{ actual, predicted string }
	var peakPairs []struct{ actual, predicted float64 }
	var durationPairs []struct{ actual, predicted float64 }

	for _, record := range records {
		switch normalizeRisk(record.PredictedRisk) {
		case "low":
			result.RiskLow++
		case "elevated":
			result.RiskElevated++
		case "high":
			result.RiskHigh++
		case "unknown":
			if strings.TrimSpace(record.PredictedRisk) == "" {
				result.RiskMissing++
			} else {
				result.RiskUnknown++
			}
		}

		switch telemetry.Outcome(strings.TrimSpace(record.Outcome)) {
		case telemetry.OutcomeSuccess:
			result.OutcomeSuccess++
		case telemetry.OutcomeSkipped:
			result.OutcomeSkipped++
		case telemetry.OutcomeTimeout:
			result.OutcomeTimeout++
		case telemetry.OutcomeError:
			result.OutcomeError++
		case telemetry.OutcomeFallback:
			result.OutcomeFallback++
			result.FallbackUsage++
		default:
			if strings.TrimSpace(record.Outcome) == "" {
				result.OutcomeMissing++
			} else {
				result.OutcomeUnknown++
			}
		}

		switch telemetry.State(strings.TrimSpace(record.State)) {
		case telemetry.StateNoData:
			result.StateNoData++
		case telemetry.StatePartialData:
			result.StatePartialData++
		case telemetry.StateProviderError:
			result.StateProviderError++
			result.ProviderErrors++
		case telemetry.StateModelUnavailable:
			result.StateModelUnavailable++
		}

		if record.IncompleteFeatures || telemetry.State(strings.TrimSpace(record.State)) == telemetry.StatePartialData {
			result.IncompleteFeatureRecords++
		}

		actualRisk := strings.TrimSpace(record.ActualRisk)
		if actualRisk != "" {
			result.LabeledOutcomes++
			labeledRisk = append(labeledRisk, struct{ actual, predicted string }{
				actual:    actualRisk,
				predicted: record.PredictedRisk,
			})
		}
		if record.ActualPeakRSSMB != nil && record.PredictedPeakRSSMB != nil {
			peakPairs = append(peakPairs, struct{ actual, predicted float64 }{
				actual:    *record.ActualPeakRSSMB,
				predicted: *record.PredictedPeakRSSMB,
			})
		}
		if record.ActualDurationS != nil && record.PredictedDurationS != nil {
			durationPairs = append(durationPairs, struct{ actual, predicted float64 }{
				actual:    *record.ActualDurationS,
				predicted: *record.PredictedDurationS,
			})
		}
	}

	if len(labeledRisk) > 0 || len(peakPairs) > 0 || len(durationPairs) > 0 {
		result.CalibrationAvailable = true
	}
	if len(labeledRisk) > 0 {
		result.RiskAccuracyRate = roundFour(labeledRiskAccuracy(labeledRisk))
	}
	if len(peakPairs) > 0 {
		result.PeakRSSMAPE = roundFour(pairMAPE(peakPairs))
	}
	if len(durationPairs) > 0 {
		result.DurationMAPE = roundFour(pairMAPE(durationPairs))
	}

	if result.RiskMissing+result.RiskUnknown > 0 {
		result.Notes = append(result.Notes, "missing or unknown predicted risk present")
	}
	if result.ProviderErrors > 0 {
		result.Notes = append(result.Notes, "provider errors observed")
	}
	if result.FallbackUsage > 0 {
		result.Notes = append(result.Notes, "fallback usage observed")
	}
	if result.IncompleteFeatureRecords > 0 {
		result.Notes = append(result.Notes, "incomplete feature records observed")
	}
	if result.CalibrationAvailable {
		result.Notes = append(result.Notes, "calibration signals computed from labeled outcomes")
	}
	return result
}

func labeledRiskAccuracy(pairs []struct{ actual, predicted string }) float64 {
	matches := 0
	scored := 0
	for _, pair := range pairs {
		actual := normalizeRisk(pair.actual)
		predicted := normalizeRisk(pair.predicted)
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

func pairMAPE(pairs []struct{ actual, predicted float64 }) float64 {
	total := 0.0
	count := 0
	for _, pair := range pairs {
		if pair.actual <= 0 {
			continue
		}
		total += math.Abs(pair.actual-pair.predicted) / pair.actual
		count++
	}
	if count == 0 {
		return 0
	}
	return total / float64(count)
}

// SavePredictionReportJSON writes the private prediction-quality JSON artifact.
func SavePredictionReportJSON(path string, report PredictionReport) error {
	body, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return err
	}
	body = append(body, '\n')
	return os.WriteFile(path, body, 0o644)
}

// PredictionCheckpointByWindow indexes prediction-quality checkpoints for tests and callers.
func PredictionCheckpointByWindow(report PredictionReport) map[int]WindowPredictionQuality {
	byWindow := make(map[int]WindowPredictionQuality, len(report.Checkpoints))
	for _, checkpoint := range report.Checkpoints {
		byWindow[checkpoint.ObservationWindowS] = checkpoint
	}
	return byWindow
}
