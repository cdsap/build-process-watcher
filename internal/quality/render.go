package quality

import (
	"bytes"
	"fmt"
	"strings"
)

// RenderMarkdown returns a private markdown quality report for promotion review.
func RenderMarkdown(report Report) (string, error) {
	var buffer bytes.Buffer
	fmt.Fprintf(&buffer, "# Recurring Model Quality Report\n\n")
	fmt.Fprintf(&buffer, "- Model set: `%s`\n", report.ModelSetVersion)
	fmt.Fprintf(&buffer, "- Checkpoint windows: %d\n", len(report.Checkpoints))
	fmt.Fprintf(&buffer, "- Purpose: review prediction error and risk-class quality against a simple baseline before promotion decisions\n\n")

	sparseCount := 0
	noCandidateCount := 0
	for _, checkpoint := range report.Checkpoints {
		if checkpoint.Sparse {
			sparseCount++
		}
		if checkpoint.CandidateModelVersion == "" {
			noCandidateCount++
		}
	}
	fmt.Fprintf(&buffer, "- Sparse windows: %d\n", sparseCount)
	fmt.Fprintf(&buffer, "- Windows without promotable candidate: %d\n\n", noCandidateCount)

	for _, checkpoint := range report.Checkpoints {
		fmt.Fprintf(&buffer, "## %s\n\n", formatWindow(checkpoint.ObservationWindowS))
		fmt.Fprintf(&buffer, "- Cohort size: %d\n", checkpoint.CohortSize)
		if checkpoint.Sparse {
			fmt.Fprintf(&buffer, "- Coverage: sparse checkpoint coverage\n")
		} else {
			fmt.Fprintf(&buffer, "- Coverage: sufficient for review\n")
		}
		if checkpoint.CandidateModelVersion == "" {
			fmt.Fprintf(&buffer, "- Candidate model: none (no promotable candidate model)\n")
		} else {
			fmt.Fprintf(&buffer, "- Candidate model: `%s`\n", checkpoint.CandidateModelVersion)
		}
		fmt.Fprintf(&buffer, "- Current peak RSS MAPE: %.4f\n", checkpoint.PeakRSSMAPE)
		fmt.Fprintf(&buffer, "- Baseline peak RSS MAPE: %.4f\n", checkpoint.BaselinePeakRSSMAPE)
		fmt.Fprintf(&buffer, "- Current duration MAPE: %.4f\n", checkpoint.DurationMAPE)
		fmt.Fprintf(&buffer, "- Baseline duration MAPE: %.4f\n", checkpoint.BaselineDurationMAPE)
		fmt.Fprintf(&buffer, "- Current risk-class accuracy: %.4f\n", checkpoint.RiskAccuracyRate)
		fmt.Fprintf(&buffer, "- Baseline risk-class accuracy: %.4f\n", checkpoint.BaselineRiskAccuracyRate)
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

// ValidatePrivateReport rejects report text that leaks private implementation details
// or customer metadata.
func ValidatePrivateReport(text string) error {
	normalized := strings.ToLower(text)
	forbidden := []string{
		"feature formula",
		"training corpus",
		"customer",
		"repository",
		"branch",
		"commit message",
		"vm_flags",
		"vmflags",
		"min_cohort",
		"max_peak_rss_mape",
		"max_duration_mape",
		"min_risk_accuracy_rate",
		"guaranteed",
		"will fail",
		"will oom",
		"will time out",
	}
	for _, phrase := range forbidden {
		if strings.Contains(normalized, phrase) {
			return fmt.Errorf("report contains private or certainty phrase %q", phrase)
		}
	}
	return nil
}

func formatWindow(window int) string {
	switch {
	case window == 60:
		return "60s"
	case window > 0 && window%60 == 0:
		return fmt.Sprintf("%dm", window/60)
	default:
		return fmt.Sprintf("%ds", window)
	}
}
