package relprogress

import (
	"fmt"
	"hash/fnv"
	"os"
	"strconv"
	"strings"

	"github.com/cdsap/build-process-watcher-predictive-provider/internal/telemetry"
)

// Private canary actions after readiness evaluation.
// Disabled or non-selected runs keep fixed-window scoring as the rollback path.
const (
	CanaryActionDisabled      = "disabled"
	CanaryActionScoreRelative = "score_relative"
	CanaryActionSkipRelative  = "skip_relative"
	CanaryActionFallbackFixed = "fallback_fixed"
)

// Private canary telemetry reasons kept out of public checkpoint fields.
const (
	CanaryReasonDisabled             = "canary disabled"
	CanaryReasonReadinessNotPassed   = "readiness gate did not pass"
	CanaryReasonNotSelected          = "run not selected for canary rollout"
	CanaryReasonControlledRun        = "controlled run allowlist"
	CanaryReasonRolloutFraction      = "rollout fraction selected"
	CanaryReasonMissingRunID         = "missing run id for canary selection"
	CanaryReasonNoRelativeCandidates = "no relative-progress candidates"
)

// CanaryConfig is the private, env-tunable canary rollout switch.
// Enable/disable and fraction changes require no code deploys beyond env updates.
type CanaryConfig struct {
	Enabled          bool
	RolloutFraction  float64
	ControlledRunIDs []string
}

// DefaultCanaryConfig returns canary disabled (fail closed onto fixed windows).
func DefaultCanaryConfig() CanaryConfig {
	return CanaryConfig{
		Enabled:         false,
		RolloutFraction: 0,
	}
}

// CanaryConfigFromEnv reads private canary rollout settings.
//
//   - PREDICTIVE_RELPROGRESS_CANARY_ENABLED: true/1/yes enables canary
//   - PREDICTIVE_RELPROGRESS_CANARY_FRACTION: 0.0-1.0 deterministic run-id fraction
//   - PREDICTIVE_RELPROGRESS_CANARY_RUN_IDS: comma-separated controlled run allowlist
func CanaryConfigFromEnv() CanaryConfig {
	config := DefaultCanaryConfig()
	config.Enabled = parseEnvBool(os.Getenv("PREDICTIVE_RELPROGRESS_CANARY_ENABLED"))
	config.RolloutFraction = parseEnvFraction(os.Getenv("PREDICTIVE_RELPROGRESS_CANARY_FRACTION"))
	config.ControlledRunIDs = parseEnvCSV(os.Getenv("PREDICTIVE_RELPROGRESS_CANARY_RUN_IDS"))
	return config
}

// CanaryDecision is the private per-run canary outcome after readiness.
type CanaryDecision struct {
	Action          string
	ScoreRelative   bool
	PreserveFixed   bool
	SelectedBy      string
	Reason          string
	Diagnostics     []string
	ReadinessStatus string
	ReadinessAction string
}

// CanaryPlan is the private scoring plan for one run: which candidates to score,
// which relative candidates to skip, and telemetry already prepared for ops review.
type CanaryPlan struct {
	Decision        CanaryDecision
	Selected        []Candidate
	SkippedRelative []Candidate
	TelemetryEvents []telemetry.Event
}

// EvaluateCanary decides whether relative-progress may be scored for one run.
// Readiness must already pass; canary then applies enablement, allowlist, and fraction.
// Fixed-window scoring remains available as rollback in every path.
func EvaluateCanary(readiness LiveReadinessDecision, config CanaryConfig, runID string) CanaryDecision {
	decision := CanaryDecision{
		PreserveFixed:   true,
		ReadinessStatus: readiness.Status,
		ReadinessAction: readiness.Action,
		Diagnostics:     append([]string(nil), readiness.Diagnostics...),
	}

	if !AllowsRelativeLiveScoring(readiness) {
		decision.Action = CanaryActionFallbackFixed
		decision.ScoreRelative = false
		decision.Reason = CanaryReasonReadinessNotPassed
		if len(readiness.Reasons) > 0 {
			decision.Diagnostics = append(decision.Diagnostics, readiness.Reasons...)
		}
		return decision
	}

	if !config.Enabled {
		decision.Action = CanaryActionDisabled
		decision.ScoreRelative = false
		decision.Reason = CanaryReasonDisabled
		return decision
	}

	runID = strings.TrimSpace(runID)
	if runID == "" && len(config.ControlledRunIDs) == 0 && config.RolloutFraction < 1 {
		decision.Action = CanaryActionSkipRelative
		decision.ScoreRelative = false
		decision.Reason = CanaryReasonMissingRunID
		return decision
	}

	if containsFold(config.ControlledRunIDs, runID) {
		decision.Action = CanaryActionScoreRelative
		decision.ScoreRelative = true
		decision.SelectedBy = "controlled_run"
		decision.Reason = CanaryReasonControlledRun
		return decision
	}

	if config.RolloutFraction >= 1 {
		decision.Action = CanaryActionScoreRelative
		decision.ScoreRelative = true
		decision.SelectedBy = "rollout_fraction"
		decision.Reason = CanaryReasonRolloutFraction
		return decision
	}

	if runID != "" && config.RolloutFraction > 0 && runInRollout(runID, config.RolloutFraction) {
		decision.Action = CanaryActionScoreRelative
		decision.ScoreRelative = true
		decision.SelectedBy = "rollout_fraction"
		decision.Reason = CanaryReasonRolloutFraction
		return decision
	}

	decision.Action = CanaryActionSkipRelative
	decision.ScoreRelative = false
	decision.Reason = CanaryReasonNotSelected
	return decision
}

// PlanCanaryScoring builds the private canary scoring plan for mapped candidates.
// Fixed-window candidates are always selected for comparison; relative candidates
// are selected only when the canary decision scores relative.
func PlanCanaryScoring(readiness LiveReadinessDecision, config CanaryConfig, runID string, candidates []Candidate, modelVersion string) CanaryPlan {
	decision := EvaluateCanary(readiness, config, runID)
	plan := CanaryPlan{Decision: decision}

	selected := make([]Candidate, 0, len(candidates))
	skipped := make([]Candidate, 0)

	for _, candidate := range candidates {
		switch candidate.Kind {
		case KindFixed:
			selected = append(selected, candidate)
		case KindRelative:
			if decision.ScoreRelative {
				selected = append(selected, candidate)
			} else {
				skipped = append(skipped, candidate)
			}
		default:
			skipped = append(skipped, candidate)
		}
	}

	if decision.ScoreRelative {
		relativeSelected := 0
		for _, candidate := range selected {
			if candidate.Kind == KindRelative {
				relativeSelected++
			}
		}
		if relativeSelected == 0 {
			decision.Action = CanaryActionSkipRelative
			decision.ScoreRelative = false
			decision.Reason = CanaryReasonNoRelativeCandidates
			decision.SelectedBy = ""
			plan.Decision = decision
		}
	}

	plan.Selected = selected
	plan.SkippedRelative = skipped
	plan.TelemetryEvents = buildCanaryTelemetry(plan, runID, modelVersion)
	return plan
}

// CanaryLiveKinds returns checkpoint kinds permitted for this canary decision.
func CanaryLiveKinds(decision CanaryDecision) []Kind {
	if decision.ScoreRelative {
		return []Kind{KindFixed, KindRelative}
	}
	return []Kind{KindFixed}
}

// RecordCanaryTelemetry writes private canary candidate/skip/fallback events.
func RecordCanaryTelemetry(store *telemetry.Store, events []telemetry.Event) {
	if store == nil {
		return
	}
	for _, event := range events {
		store.Record(event)
	}
}

func buildCanaryTelemetry(plan CanaryPlan, runID, modelVersion string) []telemetry.Event {
	events := make([]telemetry.Event, 0, len(plan.Selected)+len(plan.SkippedRelative)+1)
	modelVersion = strings.TrimSpace(modelVersion)
	if modelVersion == "" {
		modelVersion = "canary"
	}

	for _, candidate := range plan.Selected {
		if candidate.Kind != KindRelative {
			continue
		}
		events = append(events, telemetry.Event{
			ObservationWindowS: candidate.ObservationWindowS,
			ModelVersion:       modelVersion,
			Outcome:            telemetry.OutcomeSuccess,
			RunID:              runID,
			Diagnostic: fmt.Sprintf(
				"relprogress-canary candidate selected action=%s reason=%q fraction=%.2f window=%ds",
				plan.Decision.Action,
				plan.Decision.Reason,
				candidate.Fraction,
				candidate.ObservationWindowS,
			),
		})
	}

	for _, candidate := range plan.SkippedRelative {
		outcome := telemetry.OutcomeSkipped
		if plan.Decision.Action == CanaryActionFallbackFixed {
			outcome = telemetry.OutcomeFallback
		}
		events = append(events, telemetry.Event{
			ObservationWindowS: candidate.ObservationWindowS,
			ModelVersion:       modelVersion,
			Outcome:            outcome,
			RunID:              runID,
			Diagnostic: fmt.Sprintf(
				"relprogress-canary candidate skipped action=%s reason=%q fraction=%.2f window=%ds",
				plan.Decision.Action,
				plan.Decision.Reason,
				candidate.Fraction,
				candidate.ObservationWindowS,
			),
		})
	}

	if len(plan.SkippedRelative) == 0 && !plan.Decision.ScoreRelative {
		outcome := telemetry.OutcomeSkipped
		if plan.Decision.Action == CanaryActionFallbackFixed {
			outcome = telemetry.OutcomeFallback
		}
		events = append(events, telemetry.Event{
			ObservationWindowS: 0,
			ModelVersion:       modelVersion,
			Outcome:            outcome,
			RunID:              runID,
			Diagnostic: fmt.Sprintf(
				"relprogress-canary fallback action=%s reason=%q readiness_status=%s",
				plan.Decision.Action,
				plan.Decision.Reason,
				plan.Decision.ReadinessStatus,
			),
		})
	}

	return events
}

func runInRollout(runID string, fraction float64) bool {
	if fraction <= 0 {
		return false
	}
	if fraction >= 1 {
		return true
	}
	h := fnv.New32a()
	_, _ = h.Write([]byte(runID))
	bucket := float64(h.Sum32()%10_000) / 10_000.0
	return bucket < fraction
}

func parseEnvBool(raw string) bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func parseEnvFraction(raw string) float64 {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0
	}
	value, err := strconv.ParseFloat(raw, 64)
	if err != nil || value < 0 {
		return 0
	}
	if value > 1 {
		return 1
	}
	return value
}

func parseEnvCSV(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	seen := make(map[string]bool, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" || seen[part] {
			continue
		}
		seen[part] = true
		out = append(out, part)
	}
	return out
}

func containsFold(values []string, target string) bool {
	if target == "" {
		return false
	}
	for _, value := range values {
		if strings.EqualFold(strings.TrimSpace(value), target) {
			return true
		}
	}
	return false
}
