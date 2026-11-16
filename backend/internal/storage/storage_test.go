package storage

import (
	"bytes"
	"encoding/json"
	"log"
	"strings"
	"testing"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/models"
)

func TestParseDataHistoricalAndExtendedRecords(t *testing.T) {
	start := time.Unix(100, 0)
	data := "00:00:01 | 1 | Old | 10MB | 20MB | 30MB\n" +
		"00:00:02 | 2 | Extended | 11MB | 21MB | 31MB | 0.125s | 40 | 1 | 2 | 0.456 | 900 | 12 | 0.789"

	samples, err := ParseData(data, start)
	if err != nil {
		t.Fatal(err)
	}
	if len(samples) != 2 {
		t.Fatalf("expected 2 samples, got %d", len(samples))
	}
	if samples[0].JITCompiledMethods != nil {
		t.Fatal("historical sample should have nil optional metrics")
	}
	extended := samples[1]
	assertIntPointer(t, "compiled", extended.JITCompiledMethods, 40)
	assertIntPointer(t, "jit time", extended.JITCompilationTimeMs, 456)
	assertIntPointer(t, "loaded", extended.ClassesLoaded, 900)
	assertIntPointer(t, "class time", extended.ClassLoadTimeMs, 789)
}

func TestParseDataAcceptsLegacyMillisecondGC(t *testing.T) {
	samples, err := ParseData("00:00:01 | 1 | Proc | 10MB | 20MB | 30MB | 234ms", time.Unix(0, 0))
	if err != nil || len(samples) != 1 {
		t.Fatalf("unexpected parse result: %v, %d samples", err, len(samples))
	}
	if samples[0].GCTime != 234 {
		t.Fatalf("expected 234ms, got %d", samples[0].GCTime)
	}
}

func TestParseDataDoesNotLogRawPayload(t *testing.T) {
	var buf bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(prev)

	secretLine := "00:00:01 | 42 | GradleDaemon | 10MB | 20MB | 30MB | 0.1s"
	samples, err := ParseData(secretLine, time.Unix(0, 0))
	if err != nil {
		t.Fatal(err)
	}
	if len(samples) != 1 {
		t.Fatalf("expected 1 sample, got %d", len(samples))
	}
	logged := buf.String()
	for _, forbidden := range []string{
		"Raw data:",
		"PARSING DATA",
		"Created sample:",
		"Processing line",
		secretLine,
		"GradleDaemon",
	} {
		if strings.Contains(logged, forbidden) {
			t.Fatalf("ParseData logged sensitive/verbose payload marker %q in %q", forbidden, logged)
		}
	}
}

func TestParseDataMalformedOptionalMetricDoesNotDiscardSample(t *testing.T) {
	samples, err := ParseData("00:00:01 | 1 | Proc | 10MB | 20MB | 30MB | N/A | bad | N/A | 2 | N/A | 0 | N/A | broken", time.Unix(0, 0))
	if err != nil {
		t.Fatal(err)
	}
	if len(samples) != 1 {
		t.Fatalf("expected base sample to survive, got %d samples", len(samples))
	}
	if samples[0].JITCompiledMethods != nil || samples[0].ClassLoadTimeMs != nil {
		t.Fatal("malformed optional values should be nil")
	}
	assertIntPointer(t, "invalidated", samples[0].JITInvalidatedCompilations, 2)
	assertIntPointer(t, "loaded zero", samples[0].ClassesLoaded, 0)
}

func TestSampleJSONRoundTripOptionalMetrics(t *testing.T) {
	samples, _ := ParseData("00:00:01 | 1 | Proc | 10MB | 20MB | 30MB | 0s | 5 | N/A | N/A | 0.25 | 100 | N/A | N/A", time.Unix(0, 0))
	encoded, err := json.Marshal(samples[0])
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]interface{}
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["JITCompiledMethods"] != float64(5) || decoded["JITFailedCompilations"] != nil {
		t.Fatalf("unexpected JSON: %s", encoded)
	}
}

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

func assertIntPointer(t *testing.T, name string, value *int, expected int) {
	t.Helper()
	if value == nil || *value != expected {
		t.Fatalf("%s: expected %d, got %v", name, expected, value)
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
