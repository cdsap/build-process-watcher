package telemetry

import (
	"sort"
	"sync"
	"time"
)

// Outcome is a public-safe scoring attempt result label for private ops review.
type Outcome string

const (
	OutcomeSuccess  Outcome = "success"
	OutcomeSkipped  Outcome = "skipped"
	OutcomeTimeout  Outcome = "timeout"
	OutcomeError    Outcome = "error"
	OutcomeFallback Outcome = "fallback"
)

// State distinguishes degraded and failure modes for private operational triage.
// Values stay coarse so logs/reports never expose formulas, thresholds, or corpus details.
type State string

const (
	StateNoData           State = "no_data"
	StatePartialData      State = "partial_data"
	StateProviderError    State = "provider_error"
	StateModelUnavailable State = "model_unavailable"
)

// Latency buckets keep coarse private latency distributions without raw timings.
const (
	BucketUnder50ms   = "under_50ms"
	BucketUnder100ms  = "under_100ms"
	BucketUnder250ms  = "under_250ms"
	BucketUnder500ms  = "under_500ms"
	BucketUnder1000ms = "under_1000ms"
	BucketUnder2000ms = "under_2000ms"
	BucketOver2000ms  = "over_2000ms"
)

// Event is one private live-scoring attempt.
type Event struct {
	ObservationWindowS int
	ModelVersion       string
	Outcome            Outcome
	State              State
	Latency            time.Duration
	// Diagnostic stays in private logs/ops views; never copy into public checkpoints.
	Diagnostic string
	RunID      string
}

// Stats aggregates attempts for one checkpoint window and model version.
type Stats struct {
	ObservationWindowS int            `json:"observation_window_s"`
	ModelVersion       string         `json:"model_version"`
	Attempts           int            `json:"attempts"`
	Success            int            `json:"success"`
	Skipped            int            `json:"skipped"`
	Timeout            int            `json:"timeout"`
	Error              int            `json:"error"`
	Fallback           int            `json:"fallback"`
	NoData             int            `json:"no_data"`
	PartialData        int            `json:"partial_data"`
	ProviderError      int            `json:"provider_error"`
	ModelUnavailable   int            `json:"model_unavailable"`
	LatencyBuckets     map[string]int `json:"latency_buckets"`
}

type key struct {
	window       int
	modelVersion string
}

// Store records private live-scoring telemetry for ops review.
type Store struct {
	mu    sync.Mutex
	stats map[key]*Stats
}

// NewStore creates an empty private scoring telemetry store.
func NewStore() *Store {
	return &Store{stats: make(map[key]*Stats)}
}

// Record updates per-window/model attempt counts, outcomes, states, and latency buckets.
func (s *Store) Record(event Event) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	k := key{window: event.ObservationWindowS, modelVersion: event.ModelVersion}
	stat := s.stats[k]
	if stat == nil {
		stat = &Stats{
			ObservationWindowS: event.ObservationWindowS,
			ModelVersion:       event.ModelVersion,
			LatencyBuckets:     make(map[string]int),
		}
		s.stats[k] = stat
	}
	stat.Attempts++
	switch event.Outcome {
	case OutcomeSuccess:
		stat.Success++
	case OutcomeSkipped:
		stat.Skipped++
	case OutcomeTimeout:
		stat.Timeout++
	case OutcomeFallback:
		stat.Fallback++
	default:
		stat.Error++
	}
	switch event.State {
	case StateNoData:
		stat.NoData++
	case StatePartialData:
		stat.PartialData++
	case StateProviderError:
		stat.ProviderError++
	case StateModelUnavailable:
		stat.ModelUnavailable++
	}
	stat.LatencyBuckets[LatencyBucket(event.Latency)]++
}

// Snapshot returns telemetry grouped by checkpoint window and model version.
func (s *Store) Snapshot() []Stats {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	out := make([]Stats, 0, len(s.stats))
	for _, stat := range s.stats {
		copyStat := *stat
		copyStat.LatencyBuckets = make(map[string]int, len(stat.LatencyBuckets))
		for bucket, count := range stat.LatencyBuckets {
			copyStat.LatencyBuckets[bucket] = count
		}
		out = append(out, copyStat)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].ObservationWindowS != out[j].ObservationWindowS {
			return out[i].ObservationWindowS < out[j].ObservationWindowS
		}
		return out[i].ModelVersion < out[j].ModelVersion
	})
	return out
}

// LatencyBucket maps a duration into a coarse private latency bucket.
func LatencyBucket(d time.Duration) string {
	switch {
	case d < 50*time.Millisecond:
		return BucketUnder50ms
	case d < 100*time.Millisecond:
		return BucketUnder100ms
	case d < 250*time.Millisecond:
		return BucketUnder250ms
	case d < 500*time.Millisecond:
		return BucketUnder500ms
	case d < time.Second:
		return BucketUnder1000ms
	case d < 2*time.Second:
		return BucketUnder2000ms
	default:
		return BucketOver2000ms
	}
}
