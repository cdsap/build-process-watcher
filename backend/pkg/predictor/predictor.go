package predictor

import (
	"context"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/models"
)

type Sample = models.Sample
type ProcessInfo = models.ProcessInfo
type PredictionCheckpoint = models.PredictionCheckpoint

var defaultCheckpoints = []int{60, 300, 600, 1200}

const fallbackModelVersion = "api-fallback"

// FallbackClassifier maps a provider failure onto a public-safe telemetry state
// and checkpoint message. Composition roots supply provider-specific mapping;
// the predictor package itself stays free of concrete scoring sentinel imports.
type FallbackClassifier func(err error) (state string, message string)

// DefaultFallbackClassifier returns a generic public-safe provider_error without
// inspecting provider-owned sentinel errors.
func DefaultFallbackClassifier(error) (state string, message string) {
	return "provider_error", "prediction provider error"
}

// RunSnapshot is the public input contract passed to prediction providers.
type RunSnapshot struct {
	RunID                 string
	Samples               []Sample
	ProcessInfo           map[string]ProcessInfo
	ExistingCheckpoints   []PredictionCheckpoint
	ConfiguredCheckpoints []int
	Now                   time.Time
}

// Provider returns public-safe checkpoint predictions.
type Provider interface {
	Predict(ctx context.Context, snapshot RunSnapshot, observationWindowS int) (PredictionCheckpoint, error)
}

// FallbackForError maps a provider failure to public-safe fallback telemetry
// fields and a checkpoint safe to persist or return to callers.
// classify carries provider-specific sentinel mapping from the composition root;
// a nil classifier uses DefaultFallbackClassifier.
// modelVersion is the fallback telemetry label; it is not written onto the
// checkpoint so public checkpoint JSON stays free of provider/model fields.
func FallbackForError(err error, observationWindowS int, now time.Time, classify FallbackClassifier) (state string, diagnostic string, modelVersion string, checkpoint PredictionCheckpoint) {
	if now.IsZero() {
		now = time.Now()
	}
	if classify == nil {
		classify = DefaultFallbackClassifier
	}
	state, diagnostic = classify(err)
	modelVersion = fallbackModelVersion
	checkpoint = PredictionCheckpoint{
		ObservationWindowS: observationWindowS,
		Status:             state,
		CreatedAt:          now,
		Message:            diagnostic,
	}
	return state, diagnostic, modelVersion, checkpoint
}

// NoopProvider is the default public provider. It never produces predictions.
type NoopProvider struct{}

// Predict returns a skipped checkpoint without model behavior.
func (NoopProvider) Predict(_ context.Context, snapshot RunSnapshot, observationWindowS int) (PredictionCheckpoint, error) {
	now := snapshot.Now
	if now.IsZero() {
		now = time.Now()
	}
	return PredictionCheckpoint{
		ObservationWindowS: observationWindowS,
		Status:             "skipped",
		ProviderID:         "noop",
		CreatedAt:          now,
		Message:            "prediction provider disabled",
	}, nil
}

// Enabled reports whether this provider can produce real predictions.
func Enabled(provider Provider) bool {
	switch provider.(type) {
	case nil, NoopProvider, *NoopProvider:
		return false
	default:
		return true
	}
}

// DefaultCheckpoints returns the public v1 checkpoint windows.
func DefaultCheckpoints() []int {
	checkpoints := make([]int, len(defaultCheckpoints))
	copy(checkpoints, defaultCheckpoints)
	return checkpoints
}

// PendingCheckpoints returns configured windows reached by samples and not yet ready.
func PendingCheckpoints(samples []Sample, existing []PredictionCheckpoint, configured []int) []int {
	if len(samples) == 0 || len(configured) == 0 {
		return nil
	}

	maxElapsed := 0
	for _, sample := range samples {
		if sample.ElapsedTime > maxElapsed {
			maxElapsed = sample.ElapsedTime
		}
	}

	ready := make(map[int]bool, len(existing))
	for _, checkpoint := range existing {
		if checkpoint.Status == "ready" {
			ready[checkpoint.ObservationWindowS] = true
		}
	}

	seen := make(map[int]bool, len(configured))
	var pending []int
	for _, checkpoint := range configured {
		if checkpoint <= 0 || seen[checkpoint] {
			continue
		}
		seen[checkpoint] = true
		if maxElapsed >= checkpoint && !ready[checkpoint] {
			pending = append(pending, checkpoint)
		}
	}
	sort.Ints(pending)
	return pending
}

// ParseCheckpoints parses a comma-separated checkpoint list.
func ParseCheckpoints(value string) []int {
	parts := strings.Split(value, ",")
	checkpoints := make([]int, 0, len(parts))
	seen := make(map[int]bool, len(parts))
	for _, part := range parts {
		checkpoint, err := strconv.Atoi(strings.TrimSpace(part))
		if err != nil || checkpoint <= 0 || seen[checkpoint] {
			continue
		}
		seen[checkpoint] = true
		checkpoints = append(checkpoints, checkpoint)
	}
	return checkpoints
}
