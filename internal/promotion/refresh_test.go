package promotion

import (
	"path/filepath"
	"testing"
	"time"
)

func TestEvaluateGateRejectsSparseAndFailedWindows(t *testing.T) {
	gate := DefaultGate()

	pass, reasons := EvaluateGate(CheckpointQuality{
		ObservationWindowS:    600,
		CohortSize:            1,
		Sparse:                true,
		PeakRSSMAPE:           0.9,
		DurationMAPE:          0.9,
		RiskAccuracyRate:      0.1,
		CandidateModelVersion: "cp-600s-bad",
	}, gate)
	if pass {
		t.Fatal("expected sparse/failed checkpoint to fail gate")
	}
	for _, want := range []string{
		"sparse checkpoint coverage",
		"insufficient checkpoint cohort",
		"peak rss error above gate",
		"duration error above gate",
		"risk calibration below gate",
	} {
		if !contains(reasons, want) {
			t.Fatalf("reasons = %v, want %q", reasons, want)
		}
	}
}

func TestEvaluateGateRequiresBaselineParity(t *testing.T) {
	pass, reasons := EvaluateGate(CheckpointQuality{
		ObservationWindowS:       60,
		CohortSize:               5,
		PeakRSSMAPE:              0.20,
		DurationMAPE:             0.20,
		RiskAccuracyRate:         0.80,
		BaselinePeakRSSMAPE:      0.15,
		BaselineDurationMAPE:     0.15,
		BaselineRiskAccuracyRate: 0.90,
		CandidateModelVersion:    "cp-60s-candidate",
	}, DefaultGate())
	if pass {
		t.Fatal("expected baseline regressions to fail gate")
	}
	if !contains(reasons, "peak rss worse than baseline") {
		t.Fatalf("reasons = %v, want baseline peak rss failure", reasons)
	}
	if !contains(reasons, "duration worse than baseline") {
		t.Fatalf("reasons = %v, want baseline duration failure", reasons)
	}
	if !contains(reasons, "risk calibration worse than baseline") {
		t.Fatalf("reasons = %v, want baseline risk failure", reasons)
	}
}

func TestRefreshPromotesCheckpointsIndependently(t *testing.T) {
	previous := Registry{Models: []PromotedModel{
		{ObservationWindowS: 60, ModelVersion: "cp-60s-old", ModelSetVersion: "set-old"},
		{ObservationWindowS: 300, ModelVersion: "cp-300s-old", ModelSetVersion: "set-old"},
		{ObservationWindowS: 600, ModelVersion: "cp-600s-old", ModelSetVersion: "set-old"},
		{ObservationWindowS: 1200, ModelVersion: "cp-1200s-old", ModelSetVersion: "set-old"},
	}}
	report := QualityReport{
		ModelSetVersion: "set-new",
		Checkpoints: []CheckpointQuality{
			passingCheckpoint(60, "cp-60s-new"),
			failingCheckpoint(300, "cp-300s-new", false),
			sparseCheckpoint(600, "cp-600s-new"),
			passingCheckpoint(1200, "cp-1200s-new"),
		},
	}

	result, err := Refresh(previous, report, DefaultGate(), true, time.Unix(1_700_000_000, 0).UTC())
	if err != nil {
		t.Fatal(err)
	}
	if !result.DryRun {
		t.Fatal("expected dry-run result")
	}

	byWindow := decisionsByWindow(result)
	if byWindow[60].Action != ActionPromote || byWindow[60].GateStatus != GateStatusPass || byWindow[60].ModelVersion != "cp-60s-new" {
		t.Fatalf("60s decision = %+v, want promote/pass cp-60s-new", byWindow[60])
	}
	if byWindow[300].Action != ActionRetain || byWindow[300].GateStatus != GateStatusFail || byWindow[300].ModelVersion != "cp-300s-old" {
		t.Fatalf("300s decision = %+v, want retain/fail cp-300s-old", byWindow[300])
	}
	if byWindow[600].Action != ActionRetain || byWindow[600].GateStatus != GateStatusFail || byWindow[600].ModelVersion != "cp-600s-old" {
		t.Fatalf("600s decision = %+v, want retain/fail cp-600s-old", byWindow[600])
	}
	if !contains(byWindow[600].Reasons, "sparse checkpoint coverage") {
		t.Fatalf("600s reasons = %v, want sparse coverage", byWindow[600].Reasons)
	}
	if byWindow[1200].Action != ActionPromote || byWindow[1200].GateStatus != GateStatusPass || byWindow[1200].ModelVersion != "cp-1200s-new" {
		t.Fatalf("1200s decision = %+v, want promote/pass cp-1200s-new", byWindow[1200])
	}

	versions := result.Registry.VersionMap()
	if versions[60] != "cp-60s-new" {
		t.Fatalf("registry 60s = %q, want cp-60s-new", versions[60])
	}
	if versions[300] != "cp-300s-old" {
		t.Fatalf("registry 300s = %q, want cp-300s-old", versions[300])
	}
	if versions[600] != "cp-600s-old" {
		t.Fatalf("registry 600s = %q, want cp-600s-old", versions[600])
	}
	if versions[1200] != "cp-1200s-new" {
		t.Fatalf("registry 1200s = %q, want cp-1200s-new", versions[1200])
	}
}

func TestRefreshLeavesEmptyRegistryWhenNoPreviousAndGateFails(t *testing.T) {
	report := QualityReport{
		ModelSetVersion: "set-empty",
		Checkpoints: []CheckpointQuality{
			failingCheckpoint(60, "cp-60s-new", true),
			failingCheckpoint(300, "cp-300s-new", false),
			failingCheckpoint(600, "cp-600s-new", false),
			failingCheckpoint(1200, "cp-1200s-new", true),
		},
	}

	result, err := Refresh(Registry{}, report, DefaultGate(), false, time.Unix(1_700_000_100, 0).UTC())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Registry.Models) != 0 {
		t.Fatalf("registry = %+v, want empty", result.Registry.Models)
	}
	for _, decision := range result.Decisions {
		if decision.Action != ActionNoPromotion {
			t.Fatalf("decision %+v, want no_promotion", decision)
		}
		if decision.Promoted {
			t.Fatalf("decision %+v unexpectedly promoted", decision)
		}
	}
}

func TestRefreshRejectsDuplicateQualityWindows(t *testing.T) {
	_, err := Refresh(Registry{}, QualityReport{
		Checkpoints: []CheckpointQuality{
			passingCheckpoint(60, "a"),
			passingCheckpoint(60, "b"),
		},
	}, DefaultGate(), true, time.Time{})
	if err == nil {
		t.Fatal("expected duplicate window error")
	}
}

func TestRefreshFixtureDryRunPromotesAndRetainsIndependently(t *testing.T) {
	report, err := LoadQualityReport(filepath.Join("testdata", "quality_report_mixed.json"))
	if err != nil {
		t.Fatal(err)
	}
	previous, err := LoadRegistry(filepath.Join("testdata", "registry_previous.json"))
	if err != nil {
		t.Fatal(err)
	}

	result, err := Refresh(previous, report, DefaultGate(), true, time.Unix(1_700_000_200, 0).UTC())
	if err != nil {
		t.Fatal(err)
	}

	byWindow := decisionsByWindow(result)
	if byWindow[60].Action != ActionPromote || byWindow[60].GateStatus != GateStatusPass || byWindow[60].ModelVersion != "cp-60s-fixture-new" {
		t.Fatalf("60s = %+v", byWindow[60])
	}
	if byWindow[300].Action != ActionPromote || byWindow[300].GateStatus != GateStatusPass || byWindow[300].ModelVersion != "cp-300s-fixture-new" {
		t.Fatalf("300s = %+v", byWindow[300])
	}
	if byWindow[600].Action != ActionRetain || byWindow[600].GateStatus != GateStatusFail || byWindow[600].ModelVersion != "cp-600s-fixture-old" {
		t.Fatalf("600s = %+v", byWindow[600])
	}
	if byWindow[1200].Action != ActionRetain || byWindow[1200].GateStatus != GateStatusFail || byWindow[1200].ModelVersion != "cp-1200s-fixture-old" {
		t.Fatalf("1200s = %+v", byWindow[1200])
	}
}

func TestRegistryRoundTripAndVersionLookup(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "registry.json")
	original := Registry{Models: []PromotedModel{
		{ObservationWindowS: 1200, ModelVersion: "cp-1200s-a", ModelSetVersion: "set-a", PromotedAt: "2026-08-10T00:00:00Z"},
		{ObservationWindowS: 60, ModelVersion: "cp-60s-a", ModelSetVersion: "set-a", PromotedAt: "2026-08-10T00:00:00Z"},
	}}
	if err := SaveRegistry(path, original); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadRegistry(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Models) != 2 {
		t.Fatalf("loaded models = %d, want 2", len(loaded.Models))
	}
	if loaded.Models[0].ObservationWindowS != 60 || loaded.Models[1].ObservationWindowS != 1200 {
		t.Fatalf("models not sorted by window: %+v", loaded.Models)
	}
	version, ok := loaded.ModelVersionForWindow(60)
	if !ok || version != "cp-60s-a" {
		t.Fatalf("ModelVersionForWindow(60) = %q, %v", version, ok)
	}
}

func passingCheckpoint(window int, version string) CheckpointQuality {
	return CheckpointQuality{
		ObservationWindowS:       window,
		CohortSize:               5,
		PeakRSSMAPE:              0.20,
		DurationMAPE:             0.22,
		RiskAccuracyRate:         0.80,
		BaselinePeakRSSMAPE:      0.30,
		BaselineDurationMAPE:     0.30,
		BaselineRiskAccuracyRate: 0.60,
		CandidateModelVersion:    version,
	}
}

func failingCheckpoint(window int, version string, sparse bool) CheckpointQuality {
	return CheckpointQuality{
		ObservationWindowS:    window,
		CohortSize:            1,
		Sparse:                sparse,
		PeakRSSMAPE:           0.90,
		DurationMAPE:          0.90,
		RiskAccuracyRate:      0.10,
		CandidateModelVersion: version,
	}
}

func sparseCheckpoint(window int, version string) CheckpointQuality {
	return CheckpointQuality{
		ObservationWindowS:    window,
		CohortSize:            2,
		Sparse:                true,
		PeakRSSMAPE:           0.20,
		DurationMAPE:          0.20,
		RiskAccuracyRate:      0.80,
		CandidateModelVersion: version,
		Notes:                 []string{"sparse coverage called out by quality report"},
	}
}

func decisionsByWindow(result RefreshResult) map[int]Decision {
	byWindow := make(map[int]Decision, len(result.Decisions))
	for _, decision := range result.Decisions {
		byWindow[decision.ObservationWindowS] = decision
	}
	return byWindow
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
