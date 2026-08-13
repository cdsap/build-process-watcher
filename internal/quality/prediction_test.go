package quality

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestEvaluatePredictionsEmptyDataset(t *testing.T) {
	dataset := loadPredictionFixture(t, "prediction_empty.json")
	report, err := EvaluatePredictions(dataset)
	if err != nil {
		t.Fatal(err)
	}
	if report.Period != "fixture-empty" {
		t.Fatalf("Period = %q", report.Period)
	}
	if len(report.Checkpoints) != len(CheckpointWindows) {
		t.Fatalf("checkpoints = %d, want %d", len(report.Checkpoints), len(CheckpointWindows))
	}
	for _, checkpoint := range report.Checkpoints {
		if checkpoint.PredictionVolume != 0 {
			t.Fatalf("%ds volume = %d, want 0", checkpoint.ObservationWindowS, checkpoint.PredictionVolume)
		}
		if !contains(checkpoint.Notes, "no predictions in window") {
			t.Fatalf("%ds notes = %v", checkpoint.ObservationWindowS, checkpoint.Notes)
		}
		if checkpoint.CalibrationAvailable {
			t.Fatalf("%ds unexpectedly has calibration", checkpoint.ObservationWindowS)
		}
	}

	markdown, err := RenderPredictionMarkdown(report)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(markdown, "Total predictions: 0") {
		t.Fatalf("empty report missing zero volume:\n%s", markdown)
	}
	for _, heading := range []string{"## 60s", "## 5m", "## 10m", "## 20m"} {
		if !strings.Contains(markdown, heading) {
			t.Fatalf("empty report missing heading %q:\n%s", heading, markdown)
		}
	}
}

func TestEvaluatePredictionsPartialCheckpoints(t *testing.T) {
	dataset := loadPredictionFixture(t, "prediction_partial.json")
	report, err := EvaluatePredictions(dataset)
	if err != nil {
		t.Fatal(err)
	}
	byWindow := PredictionCheckpointByWindow(report)

	sixty := byWindow[60]
	if sixty.PredictionVolume != 3 {
		t.Fatalf("60s volume = %d, want 3", sixty.PredictionVolume)
	}
	if sixty.RiskElevated != 1 || sixty.RiskUnknown != 1 || sixty.RiskMissing != 1 {
		t.Fatalf("60s risk distribution = %+v", sixty)
	}
	if sixty.OutcomeSuccess != 2 || sixty.OutcomeFallback != 1 || sixty.FallbackUsage != 1 {
		t.Fatalf("60s outcomes = %+v", sixty)
	}
	if sixty.ProviderErrors != 1 || sixty.IncompleteFeatureRecords != 1 {
		t.Fatalf("60s provider/incomplete = %+v", sixty)
	}
	if !sixty.CalibrationAvailable || sixty.LabeledOutcomes != 1 {
		t.Fatalf("60s calibration = %+v", sixty)
	}
	if sixty.RiskAccuracyRate != 1 {
		t.Fatalf("60s RiskAccuracyRate = %f, want 1", sixty.RiskAccuracyRate)
	}

	threeHundred := byWindow[300]
	if threeHundred.PredictionVolume != 2 {
		t.Fatalf("300s volume = %d, want 2", threeHundred.PredictionVolume)
	}
	if threeHundred.RiskLow != 1 || threeHundred.RiskMissing != 1 {
		t.Fatalf("300s risk distribution = %+v", threeHundred)
	}
	if threeHundred.ProviderErrors != 1 || threeHundred.OutcomeError != 1 {
		t.Fatalf("300s errors = %+v", threeHundred)
	}
	if threeHundred.CalibrationAvailable {
		t.Fatalf("300s should not have calibration: %+v", threeHundred)
	}

	for _, window := range []int{600, 1200} {
		checkpoint := byWindow[window]
		if checkpoint.PredictionVolume != 0 {
			t.Fatalf("%ds volume = %d, want 0", window, checkpoint.PredictionVolume)
		}
		if !contains(checkpoint.Notes, "no predictions in window") {
			t.Fatalf("%ds notes = %v", window, checkpoint.Notes)
		}
	}

	markdown, err := RenderPredictionMarkdown(report)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(markdown, "Incomplete feature records:") {
		t.Fatalf("partial report missing incomplete feature summary:\n%s", markdown)
	}
	if !strings.Contains(markdown, "Fallback usage:") {
		t.Fatalf("partial report missing fallback summary:\n%s", markdown)
	}
	if !strings.Contains(markdown, "Risk distribution:") {
		t.Fatalf("partial report missing risk distribution:\n%s", markdown)
	}
	if strings.Contains(strings.ToLower(markdown), "feature formula") {
		t.Fatalf("partial report leaked internals:\n%s", markdown)
	}
}

func TestEvaluatePredictionsMultiWindow(t *testing.T) {
	dataset := loadPredictionFixture(t, "prediction_multi_window.json")
	report, err := EvaluatePredictions(dataset)
	if err != nil {
		t.Fatal(err)
	}
	byWindow := PredictionCheckpointByWindow(report)

	if byWindow[60].PredictionVolume != 3 || byWindow[300].PredictionVolume != 2 {
		t.Fatalf("early windows volumes = 60:%d 300:%d", byWindow[60].PredictionVolume, byWindow[300].PredictionVolume)
	}
	if byWindow[600].PredictionVolume != 2 || byWindow[1200].PredictionVolume != 2 {
		t.Fatalf("late windows volumes = 600:%d 1200:%d", byWindow[600].PredictionVolume, byWindow[1200].PredictionVolume)
	}

	sixty := byWindow[60]
	if sixty.RiskLow != 1 || sixty.RiskElevated != 1 || sixty.RiskHigh != 1 {
		t.Fatalf("60s risk distribution = %+v", sixty)
	}
	if sixty.IncompleteFeatureRecords != 1 {
		t.Fatalf("60s IncompleteFeatureRecords = %d, want 1", sixty.IncompleteFeatureRecords)
	}
	if !sixty.CalibrationAvailable || sixty.LabeledOutcomes != 3 {
		t.Fatalf("60s calibration = %+v", sixty)
	}
	// 2 exact risk matches out of 3 labeled (high vs elevated mismatch)
	if sixty.RiskAccuracyRate < 0.66 || sixty.RiskAccuracyRate > 0.67 {
		t.Fatalf("60s RiskAccuracyRate = %f, want ~0.6667", sixty.RiskAccuracyRate)
	}

	threeHundred := byWindow[300]
	if threeHundred.RiskUnknown != 1 || threeHundred.OutcomeSkipped != 1 {
		t.Fatalf("300s unknown/skipped = %+v", threeHundred)
	}

	sixHundred := byWindow[600]
	if sixHundred.OutcomeTimeout != 1 || sixHundred.StateModelUnavailable != 1 {
		t.Fatalf("600s timeout/unavailable = %+v", sixHundred)
	}
	if sixHundred.FallbackUsage != 1 || sixHundred.ProviderErrors != 1 {
		t.Fatalf("600s fallback/provider = %+v", sixHundred)
	}

	twelveHundred := byWindow[1200]
	if twelveHundred.StateNoData != 1 || twelveHundred.RiskMissing != 1 {
		t.Fatalf("1200s no_data/missing = %+v", twelveHundred)
	}
	if !twelveHundred.CalibrationAvailable || twelveHundred.RiskAccuracyRate != 1 {
		t.Fatalf("1200s calibration = %+v", twelveHundred)
	}

	markdown, err := RenderPredictionMarkdown(report)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(markdown, "Total predictions: 9") {
		t.Fatalf("multi-window report missing total volume:\n%s", markdown)
	}
	if !strings.Contains(markdown, "Windows with labeled calibration: 3") {
		t.Fatalf("multi-window report missing labeled window count:\n%s", markdown)
	}
	if !strings.Contains(markdown, "Risk distribution:") {
		t.Fatalf("multi-window report missing risk distribution:\n%s", markdown)
	}
}

func TestEvaluatePredictionsRejectsInvalidWindow(t *testing.T) {
	_, err := EvaluatePredictions(PredictionDataset{
		Predictions: []PredictionRecord{{ObservationWindowS: 0, Outcome: "success"}},
	})
	if err == nil {
		t.Fatal("expected invalid window error")
	}
}

func loadPredictionFixture(t *testing.T, name string) PredictionDataset {
	t.Helper()
	dataset, err := LoadPredictionDatasetFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("load prediction fixture %s: %v", name, err)
	}
	return dataset
}
