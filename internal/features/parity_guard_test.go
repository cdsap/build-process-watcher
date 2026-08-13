package features

import (
	"errors"
	"strings"
	"testing"
)

func TestCompareParityMatchingFeatures(t *testing.T) {
	training := TrainingContract{
		CheckpointWindowsS: []int{60, 300},
		Features: []FeatureSpec{
			{Name: "sample_count", Type: "int"},
			{Name: "peak_rss_mb", Type: "float64"},
		},
	}
	live := LiveCatalog{
		CheckpointWindowsS: []int{60, 300},
		Features: []FeatureSpec{
			{Name: "sample_count", Type: "int"},
			{Name: "peak_rss_mb", Type: "float64"},
			{Name: "debug_only", Type: "float64"}, // extra live field must be ignored
		},
	}

	report := CompareParity(live, training)
	if report.HasBreaks() {
		t.Fatalf("expected matching parity, got breaks: %v", report.Issues)
	}
	if len(report.IgnoredExtras) != 1 || report.IgnoredExtras[0] != "debug_only" {
		t.Fatalf("IgnoredExtras = %v, want [debug_only]", report.IgnoredExtras)
	}
	if err := report.Err(); err != nil {
		t.Fatalf("Err() = %v, want nil", err)
	}
}

func TestCompareParityMissingFeatures(t *testing.T) {
	training := TrainingContract{
		CheckpointWindowsS: []int{60},
		Features: []FeatureSpec{
			{Name: "sample_count", Type: "int"},
			{Name: "peak_rss_mb", Type: "float64"},
			{Name: "heap_utilization", Type: "float64"},
		},
	}
	live := LiveCatalog{
		CheckpointWindowsS: []int{60},
		Features: []FeatureSpec{
			{Name: "sample_count", Type: "int"},
			{Name: "peak_rss_mb", Type: "float64"},
		},
	}

	report := CompareParity(live, training)
	if !report.HasBreaks() {
		t.Fatal("expected missing-feature break")
	}
	if !hasIssue(report, IssueMissing, "heap_utilization") {
		t.Fatalf("missing heap_utilization not reported: %+v", report.Issues)
	}
	err := report.Err()
	if err == nil {
		t.Fatal("Err() = nil, want fail-closed error")
	}
	if !strings.Contains(err.Error(), "heap_utilization") {
		t.Fatalf("error %q missing feature name", err)
	}
}

func TestCompareParityExtraIgnoredFields(t *testing.T) {
	training := TrainingContract{
		CheckpointWindowsS: []int{60},
		Features: []FeatureSpec{
			{Name: "sample_count", Type: "int"},
		},
	}
	live := LiveCatalog{
		CheckpointWindowsS: []int{60},
		Features: []FeatureSpec{
			{Name: "sample_count", Type: "int"},
			{Name: "experimental_signal", Type: "float64"},
			{Name: "scratchpad", Type: "string"},
		},
	}

	report := CompareParity(live, training)
	if report.HasBreaks() {
		t.Fatalf("extras must be ignored, got breaks: %+v", report.Issues)
	}
	if len(report.IgnoredExtras) != 2 {
		t.Fatalf("IgnoredExtras = %v, want 2 entries", report.IgnoredExtras)
	}
}

func TestCompareParityTypeDrift(t *testing.T) {
	training := TrainingContract{
		CheckpointWindowsS: []int{60},
		Features: []FeatureSpec{
			{Name: "sample_count", Type: "int"},
			{Name: "jit_compiled_methods", Type: "optional_int"},
		},
	}
	live := LiveCatalog{
		CheckpointWindowsS: []int{60},
		Features: []FeatureSpec{
			{Name: "sample_count", Type: "float64"},     // drifted
			{Name: "jit_compiled_methods", Type: "int"}, // drifted
		},
	}

	report := CompareParity(live, training)
	if !report.HasBreaks() {
		t.Fatal("expected type-drift breaks")
	}
	if !hasIssue(report, IssueTypeDrift, "sample_count") {
		t.Fatalf("sample_count type drift missing: %+v", report.Issues)
	}
	if !hasIssue(report, IssueTypeDrift, "jit_compiled_methods") {
		t.Fatalf("jit_compiled_methods type drift missing: %+v", report.Issues)
	}
}

func TestCompareParityCheckpointWindowCoverage(t *testing.T) {
	training := TrainingContract{
		CheckpointWindowsS: []int{60, 300, 600, 1200},
		Features: []FeatureSpec{
			{Name: "sample_count", Type: "int"},
		},
	}
	live := LiveCatalog{
		CheckpointWindowsS: []int{60, 300, 600}, // missing 1200
		Features: []FeatureSpec{
			{Name: "sample_count", Type: "int"},
		},
	}

	report := CompareParity(live, training)
	if !report.HasBreaks() {
		t.Fatal("expected checkpoint window coverage break")
	}
	if !hasIssue(report, IssueWindowGap, "1200") {
		t.Fatalf("window gap for 1200 not reported: %+v", report.Issues)
	}
}

func TestCompareParityDetectsRenamedFeature(t *testing.T) {
	training := TrainingContract{
		CheckpointWindowsS: []int{60},
		Features: []FeatureSpec{
			{Name: "peak_rss_mb", Type: "float64"},
		},
	}
	live := LiveCatalog{
		CheckpointWindowsS: []int{60},
		Features: []FeatureSpec{
			{Name: "peak_rss", Type: "float64"}, // renamed away from contract
		},
	}

	report := CompareParity(live, training)
	if !hasIssue(report, IssueMissing, "peak_rss_mb") {
		t.Fatalf("renamed feature should surface as missing peak_rss_mb: %+v", report.Issues)
	}
	if len(report.IgnoredExtras) != 1 || report.IgnoredExtras[0] != "peak_rss" {
		t.Fatalf("renamed live name should be listed as ignored extra: %v", report.IgnoredExtras)
	}
	err := report.Err()
	if err == nil || !strings.Contains(err.Error(), "peak_rss_mb") {
		t.Fatalf("fail-closed error = %v", err)
	}
}

func TestValidateTrainingParityAgainstLiveCatalog(t *testing.T) {
	if err := ValidateTrainingParity(); err != nil {
		t.Fatalf("live catalog must match checked-in training contract: %v", err)
	}
}

func TestLoadTrainingContractRejectsEmpty(t *testing.T) {
	_, err := ParseTrainingContract([]byte(`{"checkpoint_windows_s":[],"features":[]}`))
	if err == nil {
		t.Fatal("expected error for empty training contract")
	}
}

func TestParityErrorIsFailClosed(t *testing.T) {
	err := (&ParityReport{
		Issues: []ParityIssue{{Kind: IssueMissing, Feature: "x", Detail: "missing"}},
	}).Err()
	if err == nil {
		t.Fatal("expected error")
	}
	if !errors.Is(err, ErrParityBroken) {
		t.Fatalf("errors.Is(ErrParityBroken) = false for %v", err)
	}
}

func hasIssue(report ParityReport, kind, feature string) bool {
	for _, issue := range report.Issues {
		if issue.Kind == kind && issue.Feature == feature {
			return true
		}
	}
	return false
}
