package relprogress

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cdsap/build-process-watcher-predictive-provider/internal/provider"
	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
)

func TestMapLiveCandidatesKeepsPublicSafeWindows(t *testing.T) {
	predicted := 3600.0
	snapshot := predictor.RunSnapshot{
		Samples: []predictor.Sample{
			{ElapsedTime: 60, RSS: 700},
			{ElapsedTime: 1200, RSS: 1400},
			{ElapsedTime: 1800, RSS: 2800},
			{ElapsedTime: 2700, RSS: 3600},
		},
		ExistingCheckpoints: []predictor.PredictionCheckpoint{
			{ObservationWindowS: 60, Status: "ready", PredictedDurationS: &predicted},
		},
	}

	candidates := MapLiveCandidates(snapshot, DefaultMapOptions())
	if len(candidates) < len(FixedWindows)+1 {
		t.Fatalf("candidates = %d, want fixed windows plus relative", len(candidates))
	}

	seenRelative := false
	for _, candidate := range candidates {
		if candidate.ObservationWindowS <= 0 {
			t.Fatalf("invalid observation window: %+v", candidate)
		}
		if candidate.Kind == KindRelative {
			seenRelative = true
			if isFixedWindow(candidate.ObservationWindowS) {
				t.Fatalf("relative candidate collided with fixed window: %+v", candidate)
			}
			if candidate.Fraction != 0.25 && candidate.Fraction != 0.50 && candidate.Fraction != 0.75 {
				t.Fatalf("unexpected fraction: %+v", candidate)
			}
		}
	}
	if !seenRelative {
		t.Fatal("expected at least one relative-progress candidate for long estimated duration")
	}
}

func TestMapLiveCandidatesUsesDurationHintWithoutSchemaChanges(t *testing.T) {
	snapshot := predictor.RunSnapshot{
		Samples: []predictor.Sample{
			{ElapsedTime: 1800, RSS: 2800},
		},
	}
	options := DefaultMapOptions()
	options.DurationHintS = 3600
	options.IncludeUnreached = true

	relative := RelativeOnly(MapLiveCandidates(snapshot, options))
	if len(relative) == 0 {
		t.Fatal("expected relative candidates from duration hint")
	}
	for _, candidate := range relative {
		if candidate.EstimatedDurationS != 3600 {
			t.Fatalf("EstimatedDurationS = %v, want 3600", candidate.EstimatedDurationS)
		}
		if nearFixedWindow(candidate.ObservationWindowS, options.CollisionSlackS) {
			t.Fatalf("relative candidate near fixed window: %+v", candidate)
		}
	}
}

func TestPendingRelativeWindowsUsesElapsedWithoutSchemaChanges(t *testing.T) {
	predicted := 3600.0
	snapshot := predictor.RunSnapshot{
		Samples: []predictor.Sample{
			{ElapsedTime: 60, RSS: 700},
			{ElapsedTime: 1800, RSS: 2800},
		},
		ExistingCheckpoints: []predictor.PredictionCheckpoint{
			{ObservationWindowS: 60, Status: "ready", PredictedDurationS: &predicted},
			{ObservationWindowS: 1200, Status: "ready"},
		},
	}

	pending := PendingRelativeWindows(snapshot, DefaultMapOptions())
	if len(pending) == 0 {
		t.Fatal("expected pending relative windows once elapsed crosses mid-progress")
	}
	for _, window := range pending {
		if isFixedWindow(window) {
			t.Fatalf("pending relative window %d collides with fixed set", window)
		}
		if window > 1800 {
			t.Fatalf("pending window %d exceeds current elapsed", window)
		}
	}
}

func TestScoreCandidatesReturnsPublicCheckpointShape(t *testing.T) {
	predicted := 3600.0
	snapshot := predictor.RunSnapshot{
		RunID: "proto-1",
		Now:   time.Unix(10, 0).UTC(),
		Samples: []predictor.Sample{
			{ElapsedTime: 60, RSS: 700, HeapUsed: 500, HeapCap: 1000, GCTime: 2000},
			{ElapsedTime: 1200, RSS: 1400, HeapUsed: 650, HeapCap: 1000, GCTime: 12000},
			{ElapsedTime: 1800, RSS: 2800, HeapUsed: 880, HeapCap: 1000, GCTime: 90000},
		},
		ProcessInfo: map[string]predictor.ProcessInfo{
			"1": {PID: "1"},
			"2": {PID: "2"},
			"3": {PID: "3"},
			"4": {PID: "4"},
			"5": {PID: "5"},
		},
		ExistingCheckpoints: []predictor.PredictionCheckpoint{
			{ObservationWindowS: 60, Status: "ready", PredictedDurationS: &predicted},
		},
	}
	options := DefaultMapOptions()
	options.Fractions = []float64{0.50}
	candidates := RelativeOnly(MapLiveCandidates(snapshot, options))
	if len(candidates) == 0 {
		t.Fatal("expected a 50% relative candidate")
	}

	scored, err := ScoreCandidates(context.Background(), provider.New(provider.Config{
		ProviderID:   "provider-test",
		ModelVersion: "opaque-test",
	}), snapshot, candidates)
	if err != nil {
		t.Fatal(err)
	}
	if len(scored) != 1 {
		t.Fatalf("scored = %d, want 1", len(scored))
	}
	checkpoint := scored[0].Checkpoint
	if checkpoint.Status != "ready" {
		t.Fatalf("Status = %q, want ready", checkpoint.Status)
	}
	if checkpoint.ObservationWindowS != candidates[0].ObservationWindowS {
		t.Fatalf("ObservationWindowS = %d, want %d", checkpoint.ObservationWindowS, candidates[0].ObservationWindowS)
	}
	if checkpoint.ProviderID != "provider-test" || checkpoint.ModelVersion != "opaque-test" {
		t.Fatalf("checkpoint metadata = %+v", checkpoint)
	}
	if checkpoint.RiskLevel == "" || checkpoint.Confidence == "" {
		t.Fatalf("missing public-safe fields: %+v", checkpoint)
	}
}

func TestFixtureStudyComparesFixedAndRelativeAndDefersV2(t *testing.T) {
	path := filepath.Join("testdata", "fixture_runs.json")
	source, runs, err := LoadFixtureFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if source != "fixture" {
		t.Fatalf("source = %q, want fixture", source)
	}

	report, err := RunFixtureStudy(context.Background(), source, runs, DefaultEvidenceBar())
	if err != nil {
		t.Fatal(err)
	}
	if report.LongBuildRuns < 3 {
		t.Fatalf("LongBuildRuns = %d, want >= 3", report.LongBuildRuns)
	}
	if report.UniqueLateSignalRuns < 2 {
		t.Fatalf("UniqueLateSignalRuns = %d, want >= 2", report.UniqueLateSignalRuns)
	}
	if report.EvidenceBarCleared {
		t.Fatal("fixture-only study must not clear the historical-corpus evidence bar")
	}
	if report.Recommendation != RecommendationDefer {
		t.Fatalf("Recommendation = %q, want defer", report.Recommendation)
	}
	if !strings.Contains(report.RecommendationReason, "historical corpus") {
		t.Fatalf("RecommendationReason = %q, want historical corpus mention", report.RecommendationReason)
	}

	markdown, err := RenderMarkdown(report)
	if err != nil {
		t.Fatal(err)
	}
	for _, needle := range []string{
		"Recommendation: `defer`",
		"When relative-progress adds signal",
		"Fixed windows: `60s`, `5m`, `10m`, `20m`",
		"long-late-risk-1",
	} {
		if !strings.Contains(markdown, needle) {
			t.Fatalf("report missing %q:\n%s", needle, markdown)
		}
	}
}

func TestAssessRunDefinesSignalBeyondFixedWindows(t *testing.T) {
	run := FixtureRun{
		RunID:          "late",
		FinalDurationS: 3600,
		FinalPeakRSSMB: 4200,
	}
	low := 0.1
	high := 0.8
	peakFixed := 1500.0
	peakRelative := 4000.0
	durFixed := 1300.0
	durRelative := 3500.0

	assessment := AssessRun(run,
		[]ScoredCandidate{{
			Candidate: Candidate{Kind: KindFixed, ObservationWindowS: 1200},
			Checkpoint: predictor.PredictionCheckpoint{
				ObservationWindowS: 1200,
				Status:             "ready",
				RiskLevel:          "low",
				RiskScore:          &low,
				PredictedPeakRSSMB: &peakFixed,
				PredictedDurationS: &durFixed,
			},
		}},
		[]ScoredCandidate{{
			Candidate: Candidate{Kind: KindRelative, Fraction: 0.75, ObservationWindowS: 2700},
			Checkpoint: predictor.PredictionCheckpoint{
				ObservationWindowS: 2700,
				Status:             "ready",
				RiskLevel:          "high",
				RiskScore:          &high,
				PredictedPeakRSSMB: &peakRelative,
				PredictedDurationS: &durRelative,
			},
		}},
	)
	if !assessment.AddsSignal() {
		t.Fatalf("expected added signal, got %+v", assessment)
	}
}

func TestAssessRunIgnoresTrivialDurationImprovement(t *testing.T) {
	run := FixtureRun{
		RunID:          "stable-long",
		FinalDurationS: 3000,
		FinalPeakRSSMB: 1600,
	}
	peakFixed := 1500.0
	peakRelative := 1580.0
	durFixed := 1400.0
	durRelative := 2900.0
	assessment := AssessRun(run,
		[]ScoredCandidate{{
			Candidate: Candidate{Kind: KindFixed, ObservationWindowS: 1200},
			Checkpoint: predictor.PredictionCheckpoint{
				Status:             "ready",
				RiskLevel:          "low",
				PredictedPeakRSSMB: &peakFixed,
				PredictedDurationS: &durFixed,
			},
		}},
		[]ScoredCandidate{{
			Candidate: Candidate{Kind: KindRelative, Fraction: 0.75, ObservationWindowS: 2250},
			Checkpoint: predictor.PredictionCheckpoint{
				Status:             "ready",
				RiskLevel:          "low",
				PredictedPeakRSSMB: &peakRelative,
				PredictedDurationS: &durRelative,
			},
		}},
	)
	if assessment.UniqueLateSignal {
		t.Fatalf("peak/duration improvement without risk lift should not clear signal bar: %+v", assessment)
	}
}

func TestAssessRunRejectsSignalInsideFixedCoverage(t *testing.T) {
	assessment := AssessRun(FixtureRun{
		RunID:          "short",
		FinalDurationS: 900,
	}, nil, []ScoredCandidate{{
		Candidate:  Candidate{Kind: KindRelative, Fraction: 0.5, ObservationWindowS: 450},
		Checkpoint: predictor.PredictionCheckpoint{Status: "ready", RiskLevel: "elevated"},
	}})
	if assessment.AddsSignal() {
		t.Fatalf("short build should not count as added signal: %+v", assessment)
	}
	if assessment.LongBuild {
		t.Fatal("900s run must not be classified as long build")
	}
}

func TestDecideRecommendationRejectsWhenNoLateSignal(t *testing.T) {
	report := DecideRecommendation(StudyReport{
		Source:         "fixture",
		EvidenceBar:    DefaultEvidenceBar(),
		LongBuildRuns:  3,
		ShortBuildRuns: 1,
	})
	if report.Recommendation != RecommendationReject {
		t.Fatalf("Recommendation = %q, want reject", report.Recommendation)
	}
}
