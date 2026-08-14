package relprogress

import (
	"strconv"
	"strings"
	"testing"

	"github.com/cdsap/build-process-watcher-predictive-provider/internal/telemetry"
)

func TestCanaryConfigFromEnvEnableDisableAndFraction(t *testing.T) {
	t.Setenv("PREDICTIVE_RELPROGRESS_CANARY_ENABLED", "")
	t.Setenv("PREDICTIVE_RELPROGRESS_CANARY_FRACTION", "")
	t.Setenv("PREDICTIVE_RELPROGRESS_CANARY_RUN_IDS", "")

	disabled := CanaryConfigFromEnv()
	if disabled.Enabled || disabled.RolloutFraction != 0 || len(disabled.ControlledRunIDs) != 0 {
		t.Fatalf("default canary config should be disabled: %+v", disabled)
	}

	t.Setenv("PREDICTIVE_RELPROGRESS_CANARY_ENABLED", "true")
	t.Setenv("PREDICTIVE_RELPROGRESS_CANARY_FRACTION", "0.25")
	t.Setenv("PREDICTIVE_RELPROGRESS_CANARY_RUN_IDS", "run-a, run-b, run-a")

	enabled := CanaryConfigFromEnv()
	if !enabled.Enabled {
		t.Fatal("expected canary enabled from env")
	}
	if enabled.RolloutFraction != 0.25 {
		t.Fatalf("RolloutFraction = %v, want 0.25", enabled.RolloutFraction)
	}
	if len(enabled.ControlledRunIDs) != 2 {
		t.Fatalf("ControlledRunIDs = %v, want two unique ids", enabled.ControlledRunIDs)
	}
}

func TestEvaluateCanaryDisabledKeepsFixedWindowRollback(t *testing.T) {
	readiness := EvaluateLiveReadiness(passingLiveEvidence(), DefaultLiveReadinessBar())
	decision := EvaluateCanary(readiness, DefaultCanaryConfig(), "run-1")
	if decision.Action != CanaryActionDisabled {
		t.Fatalf("action = %q, want %q", decision.Action, CanaryActionDisabled)
	}
	if decision.ScoreRelative {
		t.Fatalf("disabled canary must not score relative: %+v", decision)
	}
	if !decision.PreserveFixed {
		t.Fatal("fixed windows must remain available as rollback")
	}
	if decision.Reason != CanaryReasonDisabled {
		t.Fatalf("reason = %q", decision.Reason)
	}
	if kinds := CanaryLiveKinds(decision); len(kinds) != 1 || kinds[0] != KindFixed {
		t.Fatalf("kinds = %v, want fixed only", kinds)
	}
}

func TestEvaluateCanaryFallbackWhenReadinessFails(t *testing.T) {
	readiness := EvaluateLiveReadiness(LiveReadinessEvidence{
		Source:                 "historical",
		CandidateWindows:       2,
		SparseCandidateWindows: 2,
		LongBuildRuns:          1,
		Diagnostics:            []string{"sparse sample density"},
	}, DefaultLiveReadinessBar())

	config := CanaryConfig{Enabled: true, RolloutFraction: 1}
	decision := EvaluateCanary(readiness, config, "run-canary")
	if decision.Action != CanaryActionFallbackFixed {
		t.Fatalf("action = %q, want %q", decision.Action, CanaryActionFallbackFixed)
	}
	if decision.ScoreRelative {
		t.Fatalf("failed readiness must fallback to fixed: %+v", decision)
	}
	if decision.Reason != CanaryReasonReadinessNotPassed {
		t.Fatalf("reason = %q", decision.Reason)
	}
	if !containsStringSlice(decision.Diagnostics, "sparse sample density") {
		t.Fatalf("diagnostics = %v, want readiness diagnostic retained", decision.Diagnostics)
	}
}

func TestEvaluateCanaryEnabledControlledRunAndFraction(t *testing.T) {
	readiness := EvaluateLiveReadiness(passingLiveEvidence(), DefaultLiveReadinessBar())

	controlled := EvaluateCanary(readiness, CanaryConfig{
		Enabled:          true,
		RolloutFraction:  0,
		ControlledRunIDs: []string{"run-allow"},
	}, "run-allow")
	if controlled.Action != CanaryActionScoreRelative || !controlled.ScoreRelative {
		t.Fatalf("controlled run should score relative: %+v", controlled)
	}
	if controlled.SelectedBy != "controlled_run" || controlled.Reason != CanaryReasonControlledRun {
		t.Fatalf("controlled selection = %+v", controlled)
	}

	full := EvaluateCanary(readiness, CanaryConfig{Enabled: true, RolloutFraction: 1}, "any-run")
	if full.Action != CanaryActionScoreRelative || full.SelectedBy != "rollout_fraction" {
		t.Fatalf("full fraction should score relative: %+v", full)
	}

	skipped := EvaluateCanary(readiness, CanaryConfig{Enabled: true, RolloutFraction: 0}, "run-other")
	if skipped.Action != CanaryActionSkipRelative || skipped.ScoreRelative {
		t.Fatalf("non-selected run should skip relative: %+v", skipped)
	}
	if skipped.Reason != CanaryReasonNotSelected {
		t.Fatalf("skip reason = %q", skipped.Reason)
	}
}

func TestEvaluateCanaryRolloutFractionIsDeterministic(t *testing.T) {
	readiness := EvaluateLiveReadiness(passingLiveEvidence(), DefaultLiveReadinessBar())
	config := CanaryConfig{Enabled: true, RolloutFraction: 0.5}

	first := EvaluateCanary(readiness, config, "stable-run-id")
	second := EvaluateCanary(readiness, config, "stable-run-id")
	if first.ScoreRelative != second.ScoreRelative || first.Action != second.Action {
		t.Fatalf("rollout selection must be deterministic: first=%+v second=%+v", first, second)
	}

	selected := 0
	for i := 0; i < 200; i++ {
		runID := "bucket-run-" + strconv.Itoa(i)
		if EvaluateCanary(readiness, config, runID).ScoreRelative {
			selected++
		}
	}
	if selected < 60 || selected > 140 {
		t.Fatalf("approx 50%% rollout selected %d/200 runs", selected)
	}
}

func TestPlanCanaryScoringPreservesFixedWindowsAndEmitsTelemetry(t *testing.T) {
	readiness := EvaluateLiveReadiness(passingLiveEvidence(), DefaultLiveReadinessBar())
	candidates := []Candidate{
		{Kind: KindFixed, ObservationWindowS: 60},
		{Kind: KindFixed, ObservationWindowS: 1200},
		{Kind: KindRelative, Fraction: 0.75, ObservationWindowS: 2700},
	}

	enabled := PlanCanaryScoring(readiness, CanaryConfig{
		Enabled:          true,
		ControlledRunIDs: []string{"run-canary"},
	}, "run-canary", candidates, "model-canary")
	if !enabled.Decision.ScoreRelative {
		t.Fatalf("enabled plan should score relative: %+v", enabled.Decision)
	}
	if len(enabled.Selected) != 3 {
		t.Fatalf("selected = %d, want fixed+relative", len(enabled.Selected))
	}
	if len(enabled.SkippedRelative) != 0 {
		t.Fatalf("skipped = %v, want none", enabled.SkippedRelative)
	}
	if len(enabled.TelemetryEvents) != 1 {
		t.Fatalf("telemetry events = %d, want 1 selected candidate", len(enabled.TelemetryEvents))
	}
	if enabled.TelemetryEvents[0].Outcome != telemetry.OutcomeSuccess {
		t.Fatalf("selected outcome = %q", enabled.TelemetryEvents[0].Outcome)
	}
	if !strings.Contains(enabled.TelemetryEvents[0].Diagnostic, "candidate selected") {
		t.Fatalf("diagnostic = %q", enabled.TelemetryEvents[0].Diagnostic)
	}

	disabled := PlanCanaryScoring(readiness, DefaultCanaryConfig(), "run-canary", candidates, "model-canary")
	if disabled.Decision.Action != CanaryActionDisabled {
		t.Fatalf("disabled action = %q", disabled.Decision.Action)
	}
	if len(disabled.Selected) != 2 {
		t.Fatalf("disabled selected = %d, want fixed only", len(disabled.Selected))
	}
	for _, candidate := range disabled.Selected {
		if candidate.Kind != KindFixed {
			t.Fatalf("disabled canary leaked relative candidate: %+v", candidate)
		}
	}
	if len(disabled.SkippedRelative) != 1 {
		t.Fatalf("disabled skipped = %d, want 1", len(disabled.SkippedRelative))
	}
	if len(disabled.TelemetryEvents) != 1 || disabled.TelemetryEvents[0].Outcome != telemetry.OutcomeSkipped {
		t.Fatalf("disabled telemetry = %+v", disabled.TelemetryEvents)
	}

	fallbackReadiness := EvaluateLiveReadiness(LiveReadinessEvidence{
		Source: "historical",
	}, DefaultLiveReadinessBar())
	fallback := PlanCanaryScoring(fallbackReadiness, CanaryConfig{Enabled: true, RolloutFraction: 1}, "run-canary", candidates, "model-canary")
	if fallback.Decision.Action != CanaryActionFallbackFixed {
		t.Fatalf("fallback action = %q", fallback.Decision.Action)
	}
	if len(fallback.Selected) != 2 {
		t.Fatalf("fallback must retain fixed windows, selected=%d", len(fallback.Selected))
	}
	if len(fallback.TelemetryEvents) != 1 || fallback.TelemetryEvents[0].Outcome != telemetry.OutcomeFallback {
		t.Fatalf("fallback telemetry = %+v", fallback.TelemetryEvents)
	}
	if !strings.Contains(fallback.TelemetryEvents[0].Diagnostic, "candidate skipped") {
		t.Fatalf("fallback diagnostic = %q", fallback.TelemetryEvents[0].Diagnostic)
	}
}

func TestRecordCanaryTelemetryWritesPrivateStore(t *testing.T) {
	readiness := EvaluateLiveReadiness(passingLiveEvidence(), DefaultLiveReadinessBar())
	plan := PlanCanaryScoring(readiness, CanaryConfig{Enabled: true, RolloutFraction: 1}, "run-telemetry", []Candidate{
		{Kind: KindFixed, ObservationWindowS: 60},
		{Kind: KindRelative, Fraction: 0.5, ObservationWindowS: 1800},
	}, "opaque-v1")

	store := telemetry.NewStore()
	RecordCanaryTelemetry(store, plan.TelemetryEvents)
	snapshot := store.Snapshot()
	if len(snapshot) != 1 {
		t.Fatalf("snapshot = %+v, want one relative window", snapshot)
	}
	if snapshot[0].ObservationWindowS != 1800 || snapshot[0].Success != 1 {
		t.Fatalf("recorded stats = %+v", snapshot[0])
	}
}

func TestPlanCanaryScoringNoRelativeCandidatesWhenSelected(t *testing.T) {
	readiness := EvaluateLiveReadiness(passingLiveEvidence(), DefaultLiveReadinessBar())
	plan := PlanCanaryScoring(readiness, CanaryConfig{Enabled: true, RolloutFraction: 1}, "run-empty", []Candidate{
		{Kind: KindFixed, ObservationWindowS: 60},
	}, "opaque-v1")
	if plan.Decision.ScoreRelative {
		t.Fatalf("no relative candidates should clear score flag: %+v", plan.Decision)
	}
	if plan.Decision.Reason != CanaryReasonNoRelativeCandidates {
		t.Fatalf("reason = %q", plan.Decision.Reason)
	}
}

func TestCanaryEnvToggleWithoutCodeChanges(t *testing.T) {
	readiness := EvaluateLiveReadiness(passingLiveEvidence(), DefaultLiveReadinessBar())
	candidates := []Candidate{
		{Kind: KindFixed, ObservationWindowS: 300},
		{Kind: KindRelative, Fraction: 0.5, ObservationWindowS: 1500},
	}

	t.Setenv("PREDICTIVE_RELPROGRESS_CANARY_ENABLED", "false")
	t.Setenv("PREDICTIVE_RELPROGRESS_CANARY_FRACTION", "")
	t.Setenv("PREDICTIVE_RELPROGRESS_CANARY_RUN_IDS", "")
	off := PlanCanaryScoring(readiness, CanaryConfigFromEnv(), "run-toggle", candidates, "v1")
	if off.Decision.ScoreRelative {
		t.Fatalf("env disabled must keep fixed-only: %+v", off.Decision)
	}

	t.Setenv("PREDICTIVE_RELPROGRESS_CANARY_ENABLED", "on")
	t.Setenv("PREDICTIVE_RELPROGRESS_CANARY_RUN_IDS", "run-toggle")
	on := PlanCanaryScoring(readiness, CanaryConfigFromEnv(), "run-toggle", candidates, "v1")
	if !on.Decision.ScoreRelative {
		t.Fatalf("env enabled allowlist must score relative: %+v", on.Decision)
	}
}
