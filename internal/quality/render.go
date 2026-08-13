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
	fmt.Fprintf(&buffer, "- Live fixed-window checkpoints: %d\n", len(report.Checkpoints))
	fmt.Fprintf(&buffer, "- Relative-progress candidate windows: %d\n", report.RelativeProgress.CandidateWindows)
	fmt.Fprintf(&buffer, "- Purpose: review live fixed-window prediction quality and advisory relative-progress candidates against a simple baseline before promotion decisions\n\n")

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
	fmt.Fprintf(&buffer, "- Sparse live windows: %d\n", sparseCount)
	fmt.Fprintf(&buffer, "- Live windows without promotable candidate: %d\n\n", noCandidateCount)

	fmt.Fprintf(&buffer, "## Live fixed-window model quality\n\n")
	fmt.Fprintf(&buffer, "These windows drive promotion review for live scoring. Evaluation role: `%s`.\n\n", EvaluationRoleLive)

	for _, checkpoint := range report.Checkpoints {
		fmt.Fprintf(&buffer, "### %s\n\n", formatWindow(checkpoint.ObservationWindowS))
		fmt.Fprintf(&buffer, "- Evaluation role: `%s`\n", firstNonEmpty(checkpoint.EvaluationRole, EvaluationRoleLive))
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

	fmt.Fprintf(&buffer, "## Relative-progress candidate quality\n\n")
	fmt.Fprintf(&buffer, "Advisory only. Live fixed-window scoring and promotion behavior are retained. Evaluation role: `%s`.\n\n", EvaluationRoleAdvisory)
	fmt.Fprintf(&buffer, "- Live fixed windows retained: %t\n", report.RelativeProgress.LiveFixedWindowsRetained)
	fmt.Fprintf(&buffer, "- Candidate windows: %d\n", report.RelativeProgress.CandidateWindows)
	fmt.Fprintf(&buffer, "- Sparse candidate windows: %d\n", report.RelativeProgress.SparseCandidateWindows)
	fmt.Fprintf(&buffer, "- Improved candidate windows: %d\n", report.RelativeProgress.ImprovedCandidateWindows)
	if len(report.RelativeProgress.Notes) > 0 {
		fmt.Fprintf(&buffer, "- Summary: %s\n", strings.Join(report.RelativeProgress.Notes, "; "))
	}
	fmt.Fprintln(&buffer)

	if len(report.RelativeProgress.Candidates) == 0 {
		fmt.Fprintf(&buffer, "No relative-progress candidates were present in this evaluation set.\n\n")
	}
	for _, candidate := range report.RelativeProgress.Candidates {
		fmt.Fprintf(&buffer, "### Relative %s\n\n", formatWindow(candidate.ObservationWindowS))
		fmt.Fprintf(&buffer, "- Evaluation role: `%s`\n", firstNonEmpty(candidate.EvaluationRole, EvaluationRoleAdvisory))
		fmt.Fprintf(&buffer, "- Cohort size: %d\n", candidate.CohortSize)
		if candidate.Sparse {
			fmt.Fprintf(&buffer, "- Coverage: sparse relative-progress candidate coverage\n")
		} else {
			fmt.Fprintf(&buffer, "- Coverage: sufficient for advisory review\n")
		}
		if candidate.CandidateModelVersion == "" {
			fmt.Fprintf(&buffer, "- Candidate model: none (no relative-progress candidate model)\n")
		} else {
			fmt.Fprintf(&buffer, "- Candidate model: `%s`\n", candidate.CandidateModelVersion)
		}
		fmt.Fprintf(&buffer, "- Candidate peak RSS MAPE: %.4f\n", candidate.PeakRSSMAPE)
		fmt.Fprintf(&buffer, "- Baseline peak RSS MAPE: %.4f\n", candidate.BaselinePeakRSSMAPE)
		fmt.Fprintf(&buffer, "- Candidate duration MAPE: %.4f\n", candidate.DurationMAPE)
		fmt.Fprintf(&buffer, "- Baseline duration MAPE: %.4f\n", candidate.BaselineDurationMAPE)
		fmt.Fprintf(&buffer, "- Candidate risk-class accuracy: %.4f\n", candidate.RiskAccuracyRate)
		fmt.Fprintf(&buffer, "- Baseline risk-class accuracy: %.4f\n", candidate.BaselineRiskAccuracyRate)
		if candidate.ComparedFixedWindowS > 0 {
			fmt.Fprintf(&buffer, "- Compared fixed window: %s\n", formatWindow(candidate.ComparedFixedWindowS))
			fmt.Fprintf(&buffer, "- Fixed-window peak RSS MAPE: %.4f\n", candidate.FixedPeakRSSMAPE)
			fmt.Fprintf(&buffer, "- Fixed-window duration MAPE: %.4f\n", candidate.FixedDurationMAPE)
			fmt.Fprintf(&buffer, "- Fixed-window risk-class accuracy: %.4f\n", candidate.FixedRiskAccuracyRate)
		}
		fmt.Fprintf(&buffer, "- Improved versus fixed window: %t\n", candidate.ImprovedVsFixed)
		fmt.Fprintf(&buffer, "- Improved versus baseline: %t\n", candidate.ImprovedVsBaseline)
		if len(candidate.Notes) > 0 {
			fmt.Fprintf(&buffer, "- Notes: %s\n", strings.Join(candidate.Notes, "; "))
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

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
