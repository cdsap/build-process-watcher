package promotion

import (
	"encoding/json"
	"math"
	"path/filepath"
	"testing"
	"time"
)

func TestClassifyGatePassFailAndMissingEvidence(t *testing.T) {
	gate := DefaultGate()

	status, reasons := ClassifyGate(passingCheckpoint(60, "cp-60s-ok"), gate)
	if status != GateStatusPass || len(reasons) != 0 {
		t.Fatalf("pass status = %q reasons = %v", status, reasons)
	}

	status, reasons = ClassifyGate(failingCheckpoint(300, "cp-300s-bad", false), gate)
	if status != GateStatusFail {
		t.Fatalf("fail status = %q, want %q", status, GateStatusFail)
	}
	if !contains(reasons, "peak rss error above gate") {
		t.Fatalf("fail reasons = %v, want threshold failure", reasons)
	}

	status, reasons = ClassifyGate(CheckpointQuality{
		ObservationWindowS:    600,
		CohortSize:            0,
		Sparse:                true,
		PeakRSSMAPE:           0,
		DurationMAPE:          0,
		RiskAccuracyRate:      0,
		CandidateModelVersion: "",
	}, gate)
	if status != GateStatusMissingEvidence {
		t.Fatalf("missing status = %q, want %q", status, GateStatusMissingEvidence)
	}
	if !contains(reasons, "missing evaluation cohort") {
		t.Fatalf("missing reasons = %v, want missing evaluation cohort", reasons)
	}
	if !contains(reasons, "missing candidate model version") {
		t.Fatalf("missing reasons = %v, want missing candidate model version", reasons)
	}

	status, reasons = ClassifyGate(CheckpointQuality{
		ObservationWindowS:    1200,
		CohortSize:            5,
		PeakRSSMAPE:           math.NaN(),
		DurationMAPE:          0.20,
		RiskAccuracyRate:      0.80,
		CandidateModelVersion: "cp-1200s-nan",
	}, gate)
	if status != GateStatusMissingEvidence {
		t.Fatalf("nan status = %q, want %q", status, GateStatusMissingEvidence)
	}
	if !contains(reasons, "missing peak rss mape evidence") {
		t.Fatalf("nan reasons = %v, want missing peak rss mape evidence", reasons)
	}
}

func TestGateFixturesCoverPassFailAndMissingEvidence(t *testing.T) {
	previous, err := LoadRegistry(filepath.Join("testdata", "registry_previous.json"))
	if err != nil {
		t.Fatal(err)
	}
	fixedNow := time.Unix(1_700_000_300, 0).UTC()

	passReport, err := LoadQualityReport(filepath.Join("testdata", "quality_report_pass.json"))
	if err != nil {
		t.Fatal(err)
	}
	passResult, err := Refresh(previous, passReport, DefaultGate(), true, fixedNow)
	if err != nil {
		t.Fatal(err)
	}
	for _, decision := range passResult.Decisions {
		if decision.GateStatus != GateStatusPass || decision.Action != ActionPromote || !decision.Promoted {
			t.Fatalf("pass fixture decision = %+v", decision)
		}
	}

	failReport, err := LoadQualityReport(filepath.Join("testdata", "quality_report_fail.json"))
	if err != nil {
		t.Fatal(err)
	}
	failResult, err := Refresh(previous, failReport, DefaultGate(), true, fixedNow)
	if err != nil {
		t.Fatal(err)
	}
	for _, decision := range failResult.Decisions {
		if decision.GateStatus != GateStatusFail {
			t.Fatalf("fail fixture decision = %+v", decision)
		}
		if decision.Action != ActionRetain || decision.Promoted {
			t.Fatalf("fail fixture must retain previous model: %+v", decision)
		}
	}
	failVersions := failResult.Registry.VersionMap()
	if failVersions[60] != "cp-60s-fixture-old" || failVersions[1200] != "cp-1200s-fixture-old" {
		t.Fatalf("fail closed registry = %+v", failVersions)
	}

	missingReport, err := LoadQualityReport(filepath.Join("testdata", "quality_report_missing_evidence.json"))
	if err != nil {
		t.Fatal(err)
	}
	missingResult, err := Refresh(previous, missingReport, DefaultGate(), true, fixedNow)
	if err != nil {
		t.Fatal(err)
	}
	byWindow := decisionsByWindow(missingResult)
	for _, window := range []int{60, 300, 600, 1200} {
		decision := byWindow[window]
		if decision.GateStatus != GateStatusMissingEvidence {
			t.Fatalf("%ds gate_status = %q, want missing_evidence (%+v)", window, decision.GateStatus, decision)
		}
		if decision.Action != ActionRetain || decision.Promoted {
			t.Fatalf("%ds must fail closed and retain: %+v", window, decision)
		}
	}
	if !contains(byWindow[60].Reasons, "missing evaluation cohort") {
		t.Fatalf("60s reasons = %v", byWindow[60].Reasons)
	}
	if !contains(byWindow[300].Reasons, "missing candidate model version") {
		t.Fatalf("300s reasons = %v", byWindow[300].Reasons)
	}
	if !contains(byWindow[600].Reasons, "missing evaluation cohort") {
		t.Fatalf("600s reasons = %v", byWindow[600].Reasons)
	}
	if !contains(byWindow[1200].Reasons, "missing checkpoint quality window") {
		t.Fatalf("1200s reasons = %v", byWindow[1200].Reasons)
	}
	missingVersions := missingResult.Registry.VersionMap()
	if missingVersions[60] != "cp-60s-fixture-old" || missingVersions[1200] != "cp-1200s-fixture-old" {
		t.Fatalf("missing-evidence fail-closed registry = %+v", missingVersions)
	}
}

func TestRefreshGateDecisionsAreDeterministic(t *testing.T) {
	previous, err := LoadRegistry(filepath.Join("testdata", "registry_previous.json"))
	if err != nil {
		t.Fatal(err)
	}
	report, err := LoadQualityReport(filepath.Join("testdata", "quality_report_mixed.json"))
	if err != nil {
		t.Fatal(err)
	}
	fixedNow := time.Unix(1_700_000_400, 0).UTC()

	first, err := Refresh(previous, report, DefaultGate(), true, fixedNow)
	if err != nil {
		t.Fatal(err)
	}
	second, err := Refresh(previous, report, DefaultGate(), true, fixedNow)
	if err != nil {
		t.Fatal(err)
	}

	firstJSON, err := json.Marshal(first)
	if err != nil {
		t.Fatal(err)
	}
	secondJSON, err := json.Marshal(second)
	if err != nil {
		t.Fatal(err)
	}
	if string(firstJSON) != string(secondJSON) {
		t.Fatalf("refresh result not deterministic:\nfirst=%s\nsecond=%s", firstJSON, secondJSON)
	}

	byWindow := decisionsByWindow(first)
	if byWindow[60].GateStatus != GateStatusPass || byWindow[300].GateStatus != GateStatusPass {
		t.Fatalf("mixed fixture expected pass promote windows: 60=%+v 300=%+v", byWindow[60], byWindow[300])
	}
	if byWindow[600].GateStatus != GateStatusFail || byWindow[1200].GateStatus != GateStatusFail {
		t.Fatalf("mixed fixture expected fail retain windows: 600=%+v 1200=%+v", byWindow[600], byWindow[1200])
	}
}
