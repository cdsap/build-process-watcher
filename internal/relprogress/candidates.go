package relprogress

import (
	"math"
	"sort"

	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
)

// FixedWindows is the private v1 fixed observation set (60s, 5m, 10m, 20m).
var FixedWindows = []int{60, 300, 600, 1200}

// DefaultFractions are the relative-progress candidates evaluated for long builds.
var DefaultFractions = []float64{0.25, 0.50, 0.75}

// Kind identifies whether a candidate came from the fixed v1 set or relative progress.
type Kind string

const (
	KindFixed    Kind = "fixed"
	KindRelative Kind = "relative"
)

// Candidate is a public-schema-compatible checkpoint window derived privately.
// Relative progress is expressed only as observation_window_s so no public schema
// change is required.
type Candidate struct {
	Kind               Kind
	Fraction           float64
	ObservationWindowS int
	EstimatedDurationS float64
}

// MapOptions controls private candidate mapping from live telemetry.
type MapOptions struct {
	Fractions         []float64
	DurationHintS     float64
	IncludeUnreached  bool
	MinLongDurationS  float64
	CollisionSlackS   int
}

// DefaultMapOptions returns the private mapping defaults for relative-progress study.
func DefaultMapOptions() MapOptions {
	return MapOptions{
		Fractions:        append([]float64(nil), DefaultFractions...),
		MinLongDurationS: float64(FixedWindows[len(FixedWindows)-1]),
		CollisionSlackS:  30,
	}
}

// MapLiveCandidates projects live telemetry into fixed and relative-progress
// checkpoint candidates using only the public RunSnapshot shape.
func MapLiveCandidates(snapshot predictor.RunSnapshot, options MapOptions) []Candidate {
	if len(options.Fractions) == 0 {
		options.Fractions = DefaultFractions
	}
	if options.MinLongDurationS <= 0 {
		options.MinLongDurationS = float64(FixedWindows[len(FixedWindows)-1])
	}
	if options.CollisionSlackS < 0 {
		options.CollisionSlackS = 0
	}

	estimated := options.DurationHintS
	if estimated <= 0 {
		estimated = EstimateDurationS(snapshot)
	}
	maxElapsed := maxElapsedS(snapshot.Samples)

	candidates := make([]Candidate, 0, len(FixedWindows)+len(options.Fractions))
	seen := make(map[int]bool, len(FixedWindows)+len(options.Fractions))

	for _, window := range FixedWindows {
		if window <= 0 || seen[window] {
			continue
		}
		seen[window] = true
		candidates = append(candidates, Candidate{
			Kind:               KindFixed,
			ObservationWindowS: window,
			EstimatedDurationS: estimated,
		})
	}

	// Relative progress is a long-build expansion beyond fixed v1 coverage.
	if estimated > options.MinLongDurationS {
		for _, fraction := range options.Fractions {
			if fraction <= 0 || fraction >= 1 {
				continue
			}
			window := relativeWindowS(estimated, fraction)
			if window <= 0 || seen[window] {
				continue
			}
			if nearFixedWindow(window, options.CollisionSlackS) {
				continue
			}
			if !options.IncludeUnreached && maxElapsed < float64(window) && window <= int(options.MinLongDurationS) {
				continue
			}
			seen[window] = true
			candidates = append(candidates, Candidate{
				Kind:               KindRelative,
				Fraction:           fraction,
				ObservationWindowS: window,
				EstimatedDurationS: estimated,
			})
		}
	}

	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].ObservationWindowS == candidates[j].ObservationWindowS {
			return candidates[i].Kind < candidates[j].Kind
		}
		return candidates[i].ObservationWindowS < candidates[j].ObservationWindowS
	})
	return candidates
}

// RelativeOnly returns the relative-progress subset of candidates.
func RelativeOnly(candidates []Candidate) []Candidate {
	out := make([]Candidate, 0, len(candidates))
	for _, candidate := range candidates {
		if candidate.Kind == KindRelative {
			out = append(out, candidate)
		}
	}
	return out
}

// EstimateDurationS derives a private live duration prior for relative mapping.
// Prefer an existing predicted duration when present; otherwise extrapolate from
// elapsed samples without requiring public schema fields.
func EstimateDurationS(snapshot predictor.RunSnapshot) float64 {
	for i := len(snapshot.ExistingCheckpoints) - 1; i >= 0; i-- {
		checkpoint := snapshot.ExistingCheckpoints[i]
		if checkpoint.PredictedDurationS != nil && *checkpoint.PredictedDurationS > 0 {
			return *checkpoint.PredictedDurationS
		}
	}

	elapsed := maxElapsedS(snapshot.Samples)
	if elapsed <= 0 {
		return 0
	}

	// Conservative extrapolation for in-flight long builds: assume the run is
	// still early-to-mid when only fixed windows have been observed.
	lastFixed := float64(FixedWindows[len(FixedWindows)-1])
	if elapsed < lastFixed {
		return math.Round(elapsed * 1.35)
	}
	return math.Round(elapsed * 1.20)
}

func relativeWindowS(estimatedDurationS float64, fraction float64) int {
	if estimatedDurationS <= 0 || fraction <= 0 {
		return 0
	}
	window := int(math.Round(estimatedDurationS * fraction))
	if window < 1 {
		return 0
	}
	return window
}

func maxElapsedS(samples []predictor.Sample) float64 {
	maxElapsed := 0
	for _, sample := range samples {
		if sample.ElapsedTime > maxElapsed {
			maxElapsed = sample.ElapsedTime
		}
	}
	return float64(maxElapsed)
}

func nearFixedWindow(window int, slackS int) bool {
	for _, fixed := range FixedWindows {
		if window == fixed {
			return true
		}
		if absInt(window-fixed) <= slackS {
			return true
		}
	}
	return false
}

func isFixedWindow(window int) bool {
	for _, fixed := range FixedWindows {
		if fixed == window {
			return true
		}
	}
	return false
}

func absInt(value int) int {
	if value < 0 {
		return -value
	}
	return value
}
