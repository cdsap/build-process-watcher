package storage

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/models"
)

type memoryTransactionRunner struct {
	mu        sync.Mutex
	documents map[string]map[string]interface{}
}

type memoryDocumentTransaction struct {
	fields map[string]interface{}
}

func newMemoryTransactionRunner() *memoryTransactionRunner {
	return &memoryTransactionRunner{documents: make(map[string]map[string]interface{})}
}

func (r *memoryTransactionRunner) Run(
	_ context.Context,
	collection string,
	documentID string,
	fn func(documentTransaction) error,
) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	key := collection + "/" + documentID
	fields := r.documents[key]
	if fields == nil {
		fields = make(map[string]interface{})
		r.documents[key] = fields
	}
	return fn(&memoryDocumentTransaction{fields: fields})
}

func (tx *memoryDocumentTransaction) Get(destination interface{}) (bool, error) {
	if len(tx.fields) == 0 {
		return false, nil
	}
	switch doc := destination.(type) {
	case *models.RunDoc:
		if value, ok := tx.fields["samples"].([]models.Sample); ok {
			doc.Samples = append([]models.Sample(nil), value...)
		}
		if value, ok := tx.fields["prediction_checkpoints"].([]models.PredictionCheckpoint); ok {
			doc.PredictionCheckpoints = append([]models.PredictionCheckpoint(nil), value...)
		}
		if value, ok := tx.fields["process_forecasts"].([]models.ProcessForecast); ok {
			doc.ProcessForecasts = append([]models.ProcessForecast(nil), value...)
		}
		if value, ok := tx.fields["start_time"].(time.Time); ok {
			doc.StartTime = value
		}
		if value, ok := tx.fields["created_at"].(time.Time); ok {
			doc.CreatedAt = value
		}
	case *models.ProcessDoc:
		if value, ok := tx.fields["process_info"].(map[string]models.ProcessInfo); ok {
			doc.ProcessInfo = make(map[string]models.ProcessInfo, len(value))
			for pid, processInfo := range value {
				doc.ProcessInfo[pid] = processInfo
			}
		}
		if value, ok := tx.fields["created_at"].(time.Time); ok {
			doc.CreatedAt = value
		}
	}
	return true, nil
}

func (tx *memoryDocumentTransaction) Merge(fields map[string]interface{}) error {
	for key, value := range fields {
		tx.fields[key] = value
	}
	return nil
}

func (r *memoryTransactionRunner) fields(collection, documentID string) map[string]interface{} {
	r.mu.Lock()
	defer r.mu.Unlock()

	result := make(map[string]interface{})
	for key, value := range r.documents[collection+"/"+documentID] {
		result[key] = value
	}
	return result
}

func TestConcurrentRunWritesPreserveSamplesCheckpointsAndForecasts(t *testing.T) {
	runner := newMemoryTransactionRunner()
	runner.documents["runs/run-1"] = map[string]interface{}{
		"finished":        true,
		"prediction_mode": "timeline",
		"prediction_checkpoints": []models.PredictionCheckpoint{
			{ObservationWindowS: 30, Status: "ready"},
		},
		"process_forecasts": []models.ProcessForecast{
			{PID: "1", Metric: "heap"},
		},
	}
	client := &Client{ctx: context.Background(), transactions: runner}
	start := make(chan struct{})
	errors := make(chan error, 3)

	go func() {
		<-start
		errors <- client.StoreSamples("run-1", []models.Sample{{PID: "1", Name: "GradleDaemon"}})
	}()
	go func() {
		<-start
		errors <- client.StorePredictionCheckpoint("run-1", models.PredictionCheckpoint{ObservationWindowS: 60, Status: "ready"})
	}()
	go func() {
		<-start
		errors <- client.AppendProcessForecasts("run-1", []models.ProcessForecast{{PID: "1", Metric: "rss"}})
	}()

	close(start)
	for range 3 {
		if err := <-errors; err != nil {
			t.Fatal(err)
		}
	}

	fields := runner.fields("runs", "run-1")
	if samples := fields["samples"].([]models.Sample); len(samples) != 1 || samples[0].PID != "1" {
		t.Fatalf("samples were not preserved: %#v", samples)
	}
	if checkpoints := fields["prediction_checkpoints"].([]models.PredictionCheckpoint); len(checkpoints) != 2 || checkpoints[0].ObservationWindowS != 30 || checkpoints[1].ObservationWindowS != 60 {
		t.Fatalf("checkpoints were not preserved: %#v", checkpoints)
	}
	if forecasts := fields["process_forecasts"].([]models.ProcessForecast); len(forecasts) != 2 || forecasts[0].Metric != "heap" || forecasts[1].Metric != "rss" {
		t.Fatalf("forecasts were not preserved: %#v", forecasts)
	}
	if fields["finished"] != true || fields["prediction_mode"] != "timeline" {
		t.Fatalf("unrelated run fields were overwritten: %#v", fields)
	}
}

func TestStoreSamplesLeavesLegacyPredictionFieldsMissing(t *testing.T) {
	runner := newMemoryTransactionRunner()
	client := &Client{ctx: context.Background(), transactions: runner}

	if err := client.StoreSamples("legacy-run", []models.Sample{{PID: "1"}}); err != nil {
		t.Fatal(err)
	}

	fields := runner.fields("runs", "legacy-run")
	for _, field := range []string{"prediction_checkpoints", "process_forecasts", "prediction_mode"} {
		if _, exists := fields[field]; exists {
			t.Fatalf("StoreSamples added legacy-optional field %q: %#v", field, fields[field])
		}
	}
}

func TestConcurrentProcessInfoWritesPreserveEachPID(t *testing.T) {
	runner := newMemoryTransactionRunner()
	client := &Client{ctx: context.Background(), transactions: runner}
	start := make(chan struct{})
	errors := make(chan error, 2)

	for _, processInfo := range []models.ProcessInfo{
		{PID: "1", Name: "GradleDaemon"},
		{PID: "2", Name: "KotlinCompileDaemon"},
	} {
		processInfo := processInfo
		go func() {
			<-start
			errors <- client.StoreProcessInfo("run-1", processInfo)
		}()
	}

	close(start)
	for range 2 {
		if err := <-errors; err != nil {
			t.Fatal(err)
		}
	}

	fields := runner.fields("processes", "run-1")
	processes := fields["process_info"].(map[string]models.ProcessInfo)
	if len(processes) != 2 || processes["1"].Name != "GradleDaemon" || processes["2"].Name != "KotlinCompileDaemon" {
		t.Fatalf("process info was not preserved: %#v", processes)
	}
}

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
