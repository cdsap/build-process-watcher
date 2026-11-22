package storage

import (
	"fmt"
	"testing"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/models"
)

func TestStampFreshnessStoredUsesWallAndMonotonicTiming(t *testing.T) {
	receivedAt := time.Now().Add(-25 * time.Millisecond)
	samples := []models.Sample{{Freshness: &models.FreshnessTiming{
		SampleID:          "1-123",
		BackendReceivedAt: receivedAt,
	}}}
	storedAt := receivedAt.Add(25 * time.Millisecond)

	stampFreshnessStored(samples, storedAt)

	if samples[0].Freshness.BackendStoredAtUnixMs != storedAt.UnixMilli() {
		t.Fatalf("stored wall time = %d, want %d", samples[0].Freshness.BackendStoredAtUnixMs, storedAt.UnixMilli())
	}
	if samples[0].Freshness.BackendStorageDurationMs != 25 {
		t.Fatalf("storage duration = %d, want 25", samples[0].Freshness.BackendStorageDurationMs)
	}
}

func TestSampleStoreFieldsOmitsPredictionAndFinishKeys(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	existing := &models.RunDoc{
		StartTime: now.Add(-time.Minute),
		CreatedAt: now.Add(-time.Minute),
		Samples: []models.Sample{{
			PID: "1", Name: "GradleDaemon", RSS: 100,
		}},
		PredictionCheckpoints: []models.PredictionCheckpoint{{
			ObservationWindowS: 30, Status: "ready",
		}},
		ProcessForecasts: []models.ProcessForecast{{
			ProcessName: "GradleDaemon", Metric: "rss",
		}},
		Finished: true,
	}
	incoming := []models.Sample{{PID: "1", Name: "GradleDaemon", RSS: 120}}

	fields := sampleStoreFields("run-1", existing, incoming, now)

	if key := containsReservedRunWriteKey(fields); key != "" {
		t.Fatalf("sample merge unexpectedly writes reserved key %q", key)
	}
	samples, ok := fields["samples"].([]models.Sample)
	if !ok || len(samples) != 2 {
		t.Fatalf("samples = %#v, want 2 appended samples", fields["samples"])
	}
	if _, hasStart := fields["start_time"]; hasStart {
		t.Fatal("should not rewrite existing start_time")
	}
}

func TestSampleStoreFieldsStampsFreshnessInOneWrite(t *testing.T) {
	now := time.Unix(1_700_000_100, 0)
	received := now.Add(-40 * time.Millisecond)
	incoming := []models.Sample{{
		PID: "9",
		Freshness: &models.FreshnessTiming{
			SampleID:          "9-1",
			BackendReceivedAt: received,
		},
	}}

	fields := sampleStoreFields("run-fresh", nil, incoming, now)
	samples := fields["samples"].([]models.Sample)
	if samples[0].Freshness.BackendStoredAtUnixMs != now.UnixMilli() {
		t.Fatalf("stored at = %d, want %d", samples[0].Freshness.BackendStoredAtUnixMs, now.UnixMilli())
	}
	if samples[0].Freshness.BackendStorageDurationMs != 40 {
		t.Fatalf("duration = %d, want 40", samples[0].Freshness.BackendStorageDurationMs)
	}
}

func TestCheckpointAndForecastFieldsPreserveSiblingArrays(t *testing.T) {
	now := time.Unix(1_700_000_200, 0)
	existingCheckpoints := []models.PredictionCheckpoint{{
		ObservationWindowS: 30, Status: "ready",
	}}
	existingForecasts := []models.ProcessForecast{{
		ProcessName: "GradleDaemon", Metric: "rss", CreatedAtMs: 1,
	}}

	checkpointFields := checkpointStoreFields("run-1", existingCheckpoints, models.PredictionCheckpoint{
		ObservationWindowS: 60, Status: "ready",
	}, now)
	forecastFields := forecastStoreFields("run-1", existingForecasts, []models.ProcessForecast{{
		ProcessName: "KotlinCompileDaemon", Metric: "rss", CreatedAtMs: 2,
	}}, now)

	if _, hasForecasts := checkpointFields["process_forecasts"]; hasForecasts {
		t.Fatal("checkpoint write must not touch process_forecasts")
	}
	if _, hasCheckpoints := forecastFields["prediction_checkpoints"]; hasCheckpoints {
		t.Fatal("forecast write must not touch prediction_checkpoints")
	}
	if _, hasSamples := checkpointFields["samples"]; hasSamples {
		t.Fatal("checkpoint write must not touch samples")
	}
	if _, hasSamples := forecastFields["samples"]; hasSamples {
		t.Fatal("forecast write must not touch samples")
	}

	// Simulate concurrent MergeAll application order: samples, then checkpoint, then forecast.
	doc := map[string]interface{}{
		"prediction_checkpoints": existingCheckpoints,
		"process_forecasts":      existingForecasts,
		"samples": []models.Sample{{PID: "1", RSS: 10}},
		"finished": false,
	}
	applyMerge := func(fields map[string]interface{}) {
		for key, value := range fields {
			doc[key] = value
		}
	}
	applyMerge(sampleStoreFields("run-1", &models.RunDoc{
		Samples:               doc["samples"].([]models.Sample),
		PredictionCheckpoints: existingCheckpoints,
		ProcessForecasts:      existingForecasts,
	}, []models.Sample{{PID: "1", RSS: 20}}, now))
	applyMerge(checkpointFields)
	applyMerge(forecastFields)

	if got := doc["samples"].([]models.Sample); len(got) != 2 {
		t.Fatalf("samples after concurrent merges = %d, want 2", len(got))
	}
	if got := doc["prediction_checkpoints"].([]models.PredictionCheckpoint); len(got) != 2 {
		t.Fatalf("checkpoints after concurrent merges = %d, want 2", len(got))
	}
	if got := doc["process_forecasts"].([]models.ProcessForecast); len(got) != 2 {
		t.Fatalf("forecasts after concurrent merges = %d, want 2", len(got))
	}
	if doc["finished"] != false {
		t.Fatal("finish flag should remain untouched by sample/checkpoint/forecast merges")
	}
}

func TestProcessInfoStoreFieldsKeepsSiblingPIDs(t *testing.T) {
	now := time.Unix(1_700_000_300, 0)
	existing := &models.ProcessDoc{
		CreatedAt: now.Add(-time.Minute),
		ProcessInfo: map[string]models.ProcessInfo{
			"1": {PID: "1", Name: "GradleDaemon"},
		},
	}
	fields := processInfoStoreFields("run-1", existing, models.ProcessInfo{
		PID: "2", Name: "KotlinCompileDaemon",
	}, now)
	info := fields["process_info"].(map[string]models.ProcessInfo)
	if len(info) != 2 || info["1"].Name != "GradleDaemon" || info["2"].Name != "KotlinCompileDaemon" {
		t.Fatalf("process_info = %#v", info)
	}
	if _, hasCreated := fields["created_at"]; hasCreated {
		t.Fatal("should not rewrite existing created_at")
	}
}

func TestFinishStoreFieldsDoesNotRewritePredictionArrays(t *testing.T) {
	now := time.Unix(1_700_000_400, 0)
	existing := &models.RunDoc{
		StartTime: now.Add(-time.Minute),
		CreatedAt: now.Add(-time.Minute),
		Samples:   []models.Sample{{PID: "1"}},
	}
	fields := finishStoreFields("run-1", existing, now)
	for _, key := range []string{"prediction_checkpoints", "process_forecasts", "samples"} {
		if _, ok := fields[key]; ok && key != "samples" {
			t.Fatalf("finish fields unexpectedly include %q", key)
		}
	}
	if _, ok := fields["samples"]; ok {
		t.Fatal("finish must not rewrite existing samples")
	}
	if fields["finished"] != true {
		t.Fatal("expected finished=true")
	}
}

func TestIsNotFoundRecognizesWrappedErrRunNotFound(t *testing.T) {
	err := fmt.Errorf("%w: run-xyz", ErrRunNotFound)
	if !IsNotFound(err) {
		t.Fatal("expected wrapped ErrRunNotFound to match IsNotFound")
	}
	if IsNotFound(fmt.Errorf("connection reset")) {
		t.Fatal("unexpected match for unrelated error")
	}
	if IsNotFound(nil) {
		t.Fatal("nil must not be not-found")
	}
}

func TestEmptyProcessDoc(t *testing.T) {
	doc := emptyProcessDoc("run-1")
	if doc.RunID != "run-1" || doc.ProcessInfo == nil || len(doc.ProcessInfo) != 0 {
		t.Fatalf("empty process doc = %#v", doc)
	}
}

func TestIsRunStale(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	timeout := 5 * time.Minute
	tests := []struct {
		name      string
		finished  bool
		updatedAt time.Time
		want      bool
	}{
		{name: "finished never stale", finished: true, updatedAt: now.Add(-time.Hour), want: false},
		{name: "fresh unfinished", finished: false, updatedAt: now.Add(-time.Minute), want: false},
		{name: "exactly timeout not stale", finished: false, updatedAt: now.Add(-timeout), want: false},
		{name: "past timeout stale", finished: false, updatedAt: now.Add(-timeout - time.Second), want: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isRunStale(tt.finished, tt.updatedAt, now, timeout); got != tt.want {
				t.Fatalf("isRunStale = %v, want %v", got, tt.want)
			}
		})
	}
}
