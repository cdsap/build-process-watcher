package quality

import (
	"bytes"
	"fmt"
	"strings"
)

// RenderPredictionMarkdown returns a private markdown prediction-quality report.
func RenderPredictionMarkdown(report PredictionReport) (string, error) {
	var buffer bytes.Buffer
	fmt.Fprintf(&buffer, "# Recurring Prediction Quality Report\n\n")
	if report.Period != "" {
		fmt.Fprintf(&buffer, "- Period: `%s`\n", report.Period)
	}
	fmt.Fprintf(&buffer, "- Checkpoint windows: %d\n", len(report.Checkpoints))
	fmt.Fprintf(&buffer, "- Purpose: review production prediction volume, risk distribution, provider health, and labeled outcome quality over time\n\n")

	totalVolume := 0
	providerErrors := 0
	fallbackUsage := 0
	incomplete := 0
	labeledWindows := 0
	for _, checkpoint := range report.Checkpoints {
		totalVolume += checkpoint.PredictionVolume
		providerErrors += checkpoint.ProviderErrors
		fallbackUsage += checkpoint.FallbackUsage
		incomplete += checkpoint.IncompleteFeatureRecords
		if checkpoint.CalibrationAvailable {
			labeledWindows++
		}
	}
	fmt.Fprintf(&buffer, "- Total predictions: %d\n", totalVolume)
	fmt.Fprintf(&buffer, "- Provider errors: %d\n", providerErrors)
	fmt.Fprintf(&buffer, "- Fallback usage: %d\n", fallbackUsage)
	fmt.Fprintf(&buffer, "- Incomplete feature records: %d\n", incomplete)
	fmt.Fprintf(&buffer, "- Windows with labeled calibration: %d\n\n", labeledWindows)

	for _, checkpoint := range report.Checkpoints {
		fmt.Fprintf(&buffer, "## %s\n\n", formatWindow(checkpoint.ObservationWindowS))
		fmt.Fprintf(&buffer, "- Prediction volume: %d\n", checkpoint.PredictionVolume)
		fmt.Fprintf(&buffer, "- Risk distribution: low=%d elevated=%d high=%d unknown=%d missing=%d\n",
			checkpoint.RiskLow, checkpoint.RiskElevated, checkpoint.RiskHigh, checkpoint.RiskUnknown, checkpoint.RiskMissing)
		fmt.Fprintf(&buffer, "- Outcomes: success=%d skipped=%d timeout=%d error=%d fallback=%d missing=%d unknown=%d\n",
			checkpoint.OutcomeSuccess, checkpoint.OutcomeSkipped, checkpoint.OutcomeTimeout, checkpoint.OutcomeError,
			checkpoint.OutcomeFallback, checkpoint.OutcomeMissing, checkpoint.OutcomeUnknown)
		fmt.Fprintf(&buffer, "- Triage states: no_data=%d partial_data=%d provider_error=%d model_unavailable=%d\n",
			checkpoint.StateNoData, checkpoint.StatePartialData, checkpoint.StateProviderError, checkpoint.StateModelUnavailable)
		fmt.Fprintf(&buffer, "- Provider errors: %d\n", checkpoint.ProviderErrors)
		fmt.Fprintf(&buffer, "- Fallback usage: %d\n", checkpoint.FallbackUsage)
		fmt.Fprintf(&buffer, "- Incomplete feature records: %d\n", checkpoint.IncompleteFeatureRecords)
		if checkpoint.CalibrationAvailable {
			fmt.Fprintf(&buffer, "- Labeled outcomes: %d\n", checkpoint.LabeledOutcomes)
			fmt.Fprintf(&buffer, "- Risk-class accuracy: %.4f\n", checkpoint.RiskAccuracyRate)
			fmt.Fprintf(&buffer, "- Peak RSS MAPE: %.4f\n", checkpoint.PeakRSSMAPE)
			fmt.Fprintf(&buffer, "- Duration MAPE: %.4f\n", checkpoint.DurationMAPE)
		} else {
			fmt.Fprintf(&buffer, "- Calibration: unavailable (no labeled outcomes)\n")
		}
		if len(checkpoint.Notes) > 0 {
			fmt.Fprintf(&buffer, "- Notes: %s\n", strings.Join(checkpoint.Notes, "; "))
		}
		fmt.Fprintln(&buffer)
	}

	text := buffer.String()
	if err := ValidatePrivateReport(text); err != nil {
		return "", err
	}
	return text, nil
}
