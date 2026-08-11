package quality

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestEvaluateCompleteFixture(t *testing.T) {
	dataset := loadFixture(t, "complete.json")
	report, err := Evaluate(dataset)
	if err != nil {
		t.Fatal(err)
	}

	if report.ModelSetVersion != "fixture-set-complete" {
		t.Fatalf("ModelSetVersion = %q", report.ModelSetVersion)
	}
	if len(report.Checkpoints) != len(CheckpointWindows) {
		t.Fatalf("checkpoints = %d, want %d", len(report.Checkpoints), len(CheckpointWindows))
	}

	byWindow := CheckpointByWindow(report)
	for _, window := range CheckpointWindows {
		checkpoint := byWindow[window]
		if checkpoint.Sparse {
			t.Fatalf("%ds marked sparse unexpectedly: %+v", window, checkpoint)
		}
		if checkpoint.CohortSize != 3 {
			t.Fatalf("%ds CohortSize = %d, want 3", window, checkpoint.CohortSize)
		}
		if checkpoint.CandidateModelVersion == "" {
			t.Fatalf("%ds missing candidate model", window)
		}
		if checkpoint.PeakRSSMAPE >= checkpoint.BaselinePeakRSSMAPE {
			t.Fatalf("%ds current peak MAPE %f should beat baseline %f", window, checkpoint.PeakRSSMAPE, checkpoint.BaselinePeakRSSMAPE)
		}
		if checkpoint.RiskAccuracyRate < checkpoint.BaselineRiskAccuracyRate {
			t.Fatalf("%ds current risk accuracy %f should beat baseline %f", window, checkpoint.RiskAccuracyRate, checkpoint.BaselineRiskAccuracyRate)
		}
		if !contains(checkpoint.Notes, "current model outperforms simple baseline on aggregate metrics") {
			t.Fatalf("%ds notes missing baseline outperformance: %v", window, checkpoint.Notes)
		}
	}

	markdown, err := RenderMarkdown(report)
	if err != nil {
		t.Fatal(err)
	}
	for _, heading := range []string{"## 60s", "## 5m", "## 10m", "## 20m"} {
		if !strings.Contains(markdown, heading) {
			t.Fatalf("complete report missing heading %q:\n%s", heading, markdown)
		}
	}
	if !strings.Contains(markdown, "Coverage: sufficient for review") {
		t.Fatalf("complete report missing sufficient coverage language:\n%s", markdown)
	}
	if strings.Contains(markdown, "sparse checkpoint coverage") {
		t.Fatalf("complete report unexpectedly sparse:\n%s", markdown)
	}
}

func TestEvaluateSparseFixtureCallsOutCoverage(t *testing.T) {
	dataset := loadFixture(t, "sparse.json")
	report, err := Evaluate(dataset)
	if err != nil {
		t.Fatal(err)
	}

	byWindow := CheckpointByWindow(report)
	if byWindow[60].Sparse {
		t.Fatalf("60s should not be sparse: %+v", byWindow[60])
	}
	if byWindow[60].CohortSize != 3 {
		t.Fatalf("60s CohortSize = %d, want 3", byWindow[60].CohortSize)
	}

	for _, window := range []int{300, 600, 1200} {
		checkpoint := byWindow[window]
		if !checkpoint.Sparse {
			t.Fatalf("%ds should be sparse: %+v", window, checkpoint)
		}
		if !contains(checkpoint.Notes, "sparse checkpoint coverage") {
			t.Fatalf("%ds notes missing sparse callout: %v", window, checkpoint.Notes)
		}
	}
	if byWindow[300].CohortSize != 1 {
		t.Fatalf("300s CohortSize = %d, want 1", byWindow[300].CohortSize)
	}
	if byWindow[600].CohortSize != 0 || byWindow[1200].CohortSize != 0 {
		t.Fatalf("empty windows should have cohort 0: 600=%d 1200=%d", byWindow[600].CohortSize, byWindow[1200].CohortSize)
	}

	markdown, err := RenderMarkdown(report)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(markdown, "Coverage: sparse checkpoint coverage") {
		t.Fatalf("sparse report missing coverage callout:\n%s", markdown)
	}
	if !strings.Contains(markdown, "Sparse windows: 3") {
		t.Fatalf("sparse report missing sparse window count:\n%s", markdown)
	}
}

func TestEvaluateNoPromotableModelFixture(t *testing.T) {
	dataset := loadFixture(t, "no_promotable.json")
	report, err := Evaluate(dataset)
	if err != nil {
		t.Fatal(err)
	}

	for _, checkpoint := range report.Checkpoints {
		if checkpoint.CandidateModelVersion != "" {
			t.Fatalf("checkpoint %ds unexpectedly has candidate %q", checkpoint.ObservationWindowS, checkpoint.CandidateModelVersion)
		}
		if !contains(checkpoint.Notes, "no promotable candidate model") {
			t.Fatalf("checkpoint %ds missing no-promotable note: %v", checkpoint.ObservationWindowS, checkpoint.Notes)
		}
		if checkpoint.Sparse {
			t.Fatalf("checkpoint %ds should not be sparse: %+v", checkpoint.ObservationWindowS, checkpoint)
		}
	}

	markdown, err := RenderMarkdown(report)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(markdown, "Candidate model: none (no promotable candidate model)") {
		t.Fatalf("no-promotable report missing candidate callout:\n%s", markdown)
	}
	if !strings.Contains(markdown, "Windows without promotable candidate: 4") {
		t.Fatalf("no-promotable report missing candidate count:\n%s", markdown)
	}
	if !strings.Contains(markdown, "underperforms simple baseline") {
		t.Fatalf("no-promotable report missing baseline underperformance note:\n%s", markdown)
	}
}

func TestValidatePrivateReportRejectsLeaks(t *testing.T) {
	for _, text := range []string{
		"training corpus path leaked",
		"customer account abc",
		"feature formula rss_growth",
		"min_cohort = 3",
		"the build will fail",
	} {
		if err := ValidatePrivateReport(text); err == nil {
			t.Fatalf("expected validation error for %q", text)
		}
	}
}

func TestValidatePrivateReportAllowsAdvisoryQualityLanguage(t *testing.T) {
	if err := ValidatePrivateReport("risk-class accuracy should be reviewed against baseline"); err != nil {
		t.Fatal(err)
	}
}

func TestMixedCandidateVersionsYieldNoPromotableModel(t *testing.T) {
	report, err := Evaluate(Dataset{
		ModelSetVersion: "mixed-candidates",
		MinCohort:       1,
		Runs: []FinishedRun{
			{Checkpoints: []CheckpointObservation{{
				ObservationWindowS: 60, PredictedPeakRSSMB: 1, PredictedDurationS: 1, PredictedRisk: "low",
				BaselinePeakRSSMB: 2, BaselineDurationS: 2, BaselineRisk: "elevated",
				ActualPeakRSSMB: 1, ActualDurationS: 1, ActualRisk: "low",
				CandidateModelVersion: "cp-a",
			}}},
			{Checkpoints: []CheckpointObservation{{
				ObservationWindowS: 60, PredictedPeakRSSMB: 1, PredictedDurationS: 1, PredictedRisk: "low",
				BaselinePeakRSSMB: 2, BaselineDurationS: 2, BaselineRisk: "elevated",
				ActualPeakRSSMB: 1, ActualDurationS: 1, ActualRisk: "low",
				CandidateModelVersion: "cp-b",
			}}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	checkpoint := CheckpointByWindow(report)[60]
	if checkpoint.CandidateModelVersion != "" {
		t.Fatalf("mixed candidates should not promote a single version: %q", checkpoint.CandidateModelVersion)
	}
	if !contains(checkpoint.Notes, "no promotable candidate model") {
		t.Fatalf("notes = %v", checkpoint.Notes)
	}
}

func loadFixture(t *testing.T, name string) Dataset {
	t.Helper()
	dataset, err := LoadDatasetFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("load fixture %s: %v", name, err)
	}
	return dataset
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
