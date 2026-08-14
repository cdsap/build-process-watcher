package relprogress

import (
	"testing"
)

func TestClassifyLiveReadinessPassFailAndInsufficientEvidence(t *testing.T) {
	bar := DefaultLiveReadinessBar()

	status, reasons := ClassifyLiveReadiness(passingLiveEvidence(), bar)
	if status != ReadinessStatusPass || len(reasons) != 0 {
		t.Fatalf("pass status = %q reasons = %v", status, reasons)
	}

	failEvidence := passingLiveEvidence()
	failEvidence.CollisionNoiseRuns = 2
	failEvidence.ShortBuildRuns = 2
	status, reasons = ClassifyLiveReadiness(failEvidence, bar)
	if status != ReadinessStatusFail {
		t.Fatalf("fail status = %q, want %q", status, ReadinessStatusFail)
	}
	if !containsStringSlice(reasons, "short-build relative collision noise") {
		t.Fatalf("fail reasons = %v, want short-build collision noise", reasons)
	}

	status, reasons = ClassifyLiveReadiness(LiveReadinessEvidence{
		Source: "historical",
	}, bar)
	if status != ReadinessStatusInsufficientEvidence {
		t.Fatalf("missing status = %q, want %q", status, ReadinessStatusInsufficientEvidence)
	}
	if !containsStringSlice(reasons, "missing relative-progress candidate evidence") {
		t.Fatalf("missing reasons = %v, want missing candidate evidence", reasons)
	}
	if !containsStringSlice(reasons, "missing long-build cohort evidence") {
		t.Fatalf("missing reasons = %v, want missing long-build evidence", reasons)
	}
}

func TestEvaluateLiveReadinessRetainsFixedWindowOnWeakEvidence(t *testing.T) {
	bar := DefaultLiveReadinessBar()

	decision := EvaluateLiveReadiness(LiveReadinessEvidence{
		Source:                 "historical",
		CandidateWindows:       2,
		SparseCandidateWindows: 2,
		LongBuildRuns:          1,
		Diagnostics:            []string{"provider sparse sample density"},
	}, bar)
	if decision.Status != ReadinessStatusInsufficientEvidence {
		t.Fatalf("status = %q, want insufficient_evidence", decision.Status)
	}
	if decision.Action != LiveScoringActionRetainFixedWindow {
		t.Fatalf("action = %q, want retain_fixed_window", decision.Action)
	}
	if decision.LiveRelativeEnabled || AllowsRelativeLiveScoring(decision) {
		t.Fatalf("weak evidence must keep fixed-window live scoring: %+v", decision)
	}
	if !containsStringSlice(decision.Reasons, "sparse relative-progress telemetry") {
		t.Fatalf("reasons = %v, want sparse telemetry", decision.Reasons)
	}
	if len(decision.Diagnostics) != 1 || decision.Diagnostics[0] != "provider sparse sample density" {
		t.Fatalf("diagnostics = %v, want private provider diagnostic retained", decision.Diagnostics)
	}
	if kinds := LiveCandidateKinds(decision); len(kinds) != 1 || kinds[0] != KindFixed {
		t.Fatalf("kinds = %v, want fixed only", kinds)
	}
}

func TestEvaluateLiveReadinessRollsBackWhenPreviouslyEnabled(t *testing.T) {
	bar := DefaultLiveReadinessBar()

	failDecision := EvaluateLiveReadiness(LiveReadinessEvidence{
		Source:                   "historical",
		LongBuildRuns:            3,
		UniqueLateSignalRuns:     2,
		CandidateWindows:         2,
		ImprovedCandidateWindows: 1,
		PeakRSSRegressedVsFixed:  true,
		PreviouslyEnabled:        true,
		Diagnostics:              []string{"relative peak regression vs fixed"},
	}, bar)
	if failDecision.Status != ReadinessStatusFail {
		t.Fatalf("status = %q, want fail", failDecision.Status)
	}
	if failDecision.Action != LiveScoringActionRollbackToFixedWindow {
		t.Fatalf("action = %q, want rollback_to_fixed_window", failDecision.Action)
	}
	if failDecision.LiveRelativeEnabled {
		t.Fatalf("regression must disable relative live scoring: %+v", failDecision)
	}
	if !containsStringSlice(failDecision.Reasons, "peak rss worse than fixed-window baseline") {
		t.Fatalf("reasons = %v", failDecision.Reasons)
	}

	missingDecision := EvaluateLiveReadiness(LiveReadinessEvidence{
		Source:                   "fixture",
		LongBuildRuns:            3,
		UniqueLateSignalRuns:     2,
		CandidateWindows:         2,
		ImprovedCandidateWindows: 1,
		PreviouslyEnabled:        true,
	}, bar)
	if missingDecision.Status != ReadinessStatusInsufficientEvidence {
		t.Fatalf("fixture status = %q, want insufficient_evidence", missingDecision.Status)
	}
	if missingDecision.Action != LiveScoringActionRollbackToFixedWindow {
		t.Fatalf("fixture action = %q, want rollback_to_fixed_window", missingDecision.Action)
	}
}

func TestEvaluateLiveReadinessEnablesRelativeOnPass(t *testing.T) {
	decision := EvaluateLiveReadiness(passingLiveEvidence(), DefaultLiveReadinessBar())
	if decision.Status != ReadinessStatusPass {
		t.Fatalf("status = %q, want pass (%+v)", decision.Status, decision)
	}
	if decision.Action != LiveScoringActionEnableRelative {
		t.Fatalf("action = %q, want enable_relative", decision.Action)
	}
	if !decision.LiveRelativeEnabled || !AllowsRelativeLiveScoring(decision) {
		t.Fatalf("pass must enable relative live scoring: %+v", decision)
	}
	kinds := LiveCandidateKinds(decision)
	if len(kinds) != 2 || kinds[0] != KindFixed || kinds[1] != KindRelative {
		t.Fatalf("kinds = %v, want fixed+relative", kinds)
	}
}

func TestEvaluateLiveReadinessGuardsShortLongAndSparseCohorts(t *testing.T) {
	bar := DefaultLiveReadinessBar()

	shortNoise := EvaluateLiveReadiness(LiveReadinessEvidence{
		Source:                   "historical",
		LongBuildRuns:            3,
		ShortBuildRuns:           4,
		UniqueLateSignalRuns:     2,
		CollisionNoiseRuns:       1,
		CandidateWindows:         2,
		ImprovedCandidateWindows: 1,
	}, bar)
	if shortNoise.Status != ReadinessStatusFail {
		t.Fatalf("short-build noise status = %q, want fail", shortNoise.Status)
	}

	longNoSignal := EvaluateLiveReadiness(LiveReadinessEvidence{
		Source:                   "historical",
		LongBuildRuns:            3,
		CandidateWindows:         2,
		ImprovedCandidateWindows: 1,
	}, bar)
	if longNoSignal.Status != ReadinessStatusFail {
		t.Fatalf("long no-signal status = %q, want fail", longNoSignal.Status)
	}
	if !containsStringSlice(longNoSignal.Reasons, "long-build cohort shows no unique late-stage signal") {
		t.Fatalf("long no-signal reasons = %v", longNoSignal.Reasons)
	}

	sparse := EvaluateLiveReadiness(LiveReadinessEvidence{
		Source:                   "historical",
		LongBuildRuns:            3,
		UniqueLateSignalRuns:     2,
		CandidateWindows:         3,
		SparseCandidateWindows:   3,
		ImprovedCandidateWindows: 1,
	}, bar)
	if sparse.Status != ReadinessStatusInsufficientEvidence {
		t.Fatalf("sparse status = %q, want insufficient_evidence", sparse.Status)
	}
}

func passingLiveEvidence() LiveReadinessEvidence {
	return LiveReadinessEvidence{
		Source:                   "historical",
		LongBuildRuns:            3,
		ShortBuildRuns:           2,
		UniqueLateSignalRuns:     2,
		CandidateWindows:         2,
		SparseCandidateWindows:   0,
		ImprovedCandidateWindows: 1,
	}
}

func containsStringSlice(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
