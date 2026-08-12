package telemetry

import (
	"testing"
	"time"
)

func TestStoreAggregatesByWindowAndModelVersion(t *testing.T) {
	store := NewStore()
	store.Record(Event{
		ObservationWindowS: 60,
		ModelVersion:       "model-a",
		Outcome:            OutcomeSuccess,
		Latency:            10 * time.Millisecond,
	})
	store.Record(Event{
		ObservationWindowS: 60,
		ModelVersion:       "model-a",
		Outcome:            OutcomeSkipped,
		Latency:            5 * time.Millisecond,
	})
	store.Record(Event{
		ObservationWindowS: 300,
		ModelVersion:       "model-b",
		Outcome:            OutcomeTimeout,
		State:              StateModelUnavailable,
		Latency:            1500 * time.Millisecond,
	})
	store.Record(Event{
		ObservationWindowS: 300,
		ModelVersion:       "model-b",
		Outcome:            OutcomeError,
		State:              StateProviderError,
		Latency:            75 * time.Millisecond,
	})
	store.Record(Event{
		ObservationWindowS: 300,
		ModelVersion:       "model-b",
		Outcome:            OutcomeFallback,
		State:              StateNoData,
		Latency:            1 * time.Millisecond,
	})
	store.Record(Event{
		ObservationWindowS: 60,
		ModelVersion:       "model-a",
		Outcome:            OutcomeSuccess,
		State:              StatePartialData,
		Latency:            8 * time.Millisecond,
	})

	snapshot := store.Snapshot()
	if len(snapshot) != 2 {
		t.Fatalf("snapshot len = %d, want 2", len(snapshot))
	}
	if snapshot[0].ObservationWindowS != 60 || snapshot[0].ModelVersion != "model-a" {
		t.Fatalf("first stats = %+v, want window 60 model-a", snapshot[0])
	}
	if snapshot[0].Attempts != 3 || snapshot[0].Success != 2 || snapshot[0].Skipped != 1 {
		t.Fatalf("window 60 stats = %+v", snapshot[0])
	}
	if snapshot[0].PartialData != 1 {
		t.Fatalf("window 60 partial_data = %d, want 1", snapshot[0].PartialData)
	}
	if snapshot[0].LatencyBuckets[BucketUnder50ms] != 3 {
		t.Fatalf("window 60 latency buckets = %#v", snapshot[0].LatencyBuckets)
	}
	if snapshot[1].Timeout != 1 || snapshot[1].Error != 1 || snapshot[1].Fallback != 1 {
		t.Fatalf("window 300 stats = %+v", snapshot[1])
	}
	if snapshot[1].ModelUnavailable != 1 || snapshot[1].ProviderError != 1 || snapshot[1].NoData != 1 {
		t.Fatalf("window 300 state counters = %+v", snapshot[1])
	}
	if snapshot[1].LatencyBuckets[BucketUnder2000ms] != 1 || snapshot[1].LatencyBuckets[BucketUnder100ms] != 1 {
		t.Fatalf("window 300 latency buckets = %#v", snapshot[1].LatencyBuckets)
	}
}

func TestLatencyBucketBoundaries(t *testing.T) {
	cases := []struct {
		d    time.Duration
		want string
	}{
		{0, BucketUnder50ms},
		{49 * time.Millisecond, BucketUnder50ms},
		{50 * time.Millisecond, BucketUnder100ms},
		{249 * time.Millisecond, BucketUnder250ms},
		{500 * time.Millisecond, BucketUnder1000ms},
		{1999 * time.Millisecond, BucketUnder2000ms},
		{2 * time.Second, BucketOver2000ms},
	}
	for _, tc := range cases {
		if got := LatencyBucket(tc.d); got != tc.want {
			t.Fatalf("LatencyBucket(%v) = %q, want %q", tc.d, got, tc.want)
		}
	}
}
