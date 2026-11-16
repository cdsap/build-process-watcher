package storage

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/models"
)

type documentWrite struct {
	collection string
	document   string
	data       interface{}
	merge      bool
}

type fakeDocumentStore struct {
	documents map[string]interface{}
	writes    []documentWrite
}

func (f *fakeDocumentStore) Get(_ context.Context, collection, document string, dst interface{}) (bool, error) {
	value, ok := f.documents[collection+"/"+document]
	if !ok {
		return false, errors.New("not found")
	}
	source := reflect.ValueOf(value)
	if source.Kind() == reflect.Ptr {
		source = source.Elem()
	}
	target := reflect.ValueOf(dst)
	if target.Kind() != reflect.Ptr || !source.Type().AssignableTo(target.Elem().Type()) {
		return false, errors.New("incompatible destination")
	}
	target.Elem().Set(source)
	return true, nil
}

func (f *fakeDocumentStore) Set(_ context.Context, collection, document string, data interface{}, merge bool) error {
	f.writes = append(f.writes, documentWrite{
		collection: collection,
		document:   document,
		data:       data,
		merge:      merge,
	})
	return nil
}

func newStorageClient(store documentStore) *Client {
	return &Client{ctx: context.Background(), documents: store}
}

func TestRunMetadataWrites(t *testing.T) {
	t.Run("export opt-out does not write", func(t *testing.T) {
		store := &fakeDocumentStore{}
		client := newStorageClient(store)
		if err := client.SetRunExportToBigquery("run-1", false); err != nil {
			t.Fatal(err)
		}
		if len(store.writes) != 0 {
			t.Fatalf("writes = %d, want 0", len(store.writes))
		}
	})

	tests := []struct {
		name  string
		write func(*Client) error
		field string
		want  interface{}
	}{
		{name: "export", write: func(c *Client) error { return c.SetRunExportToBigquery("run-1", true) }, field: "export_to_bigquery", want: true},
		{name: "predictive reliability", write: func(c *Client) error { return c.SetRunPredictiveReliability("run-1", true) }, field: "predictive_reliability", want: true},
		{name: "prediction mode", write: func(c *Client) error { return c.SetRunPredictionMode("run-1", "forecast") }, field: "prediction_mode", want: "forecast"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &fakeDocumentStore{}
			client := newStorageClient(store)
			if err := tt.write(client); err != nil {
				t.Fatal(err)
			}
			if len(store.writes) != 1 {
				t.Fatalf("writes = %d, want 1", len(store.writes))
			}
			write := store.writes[0]
			fields, ok := write.data.(map[string]interface{})
			if !ok {
				t.Fatalf("write data = %T, want map", write.data)
			}
			if write.collection != "runs" || write.document != "run-1" || !write.merge {
				t.Fatalf("write = %#v", write)
			}
			if fields["run_id"] != "run-1" || fields[tt.field] != tt.want {
				t.Fatalf("fields = %#v", fields)
			}
			if _, ok := fields["updated_at_timestamp"].(int64); !ok {
				t.Fatalf("updated_at_timestamp = %T, want int64", fields["updated_at_timestamp"])
			}
		})
	}
}

func TestStorePredictionCheckpointMergesExisting(t *testing.T) {
	store := &fakeDocumentStore{documents: map[string]interface{}{
		"runs/run-1": models.RunDoc{PredictionCheckpoints: []models.PredictionCheckpoint{
			{ObservationWindowS: 60, Status: "pending"},
			{ObservationWindowS: 300, Status: "ready"},
		}},
	}}
	client := newStorageClient(store)
	if err := client.StorePredictionCheckpoint("run-1", models.PredictionCheckpoint{ObservationWindowS: 60, Status: "ready"}); err != nil {
		t.Fatal(err)
	}

	fields := store.writes[0].data.(map[string]interface{})
	checkpoints := fields["prediction_checkpoints"].([]models.PredictionCheckpoint)
	if len(checkpoints) != 2 || checkpoints[0].Status != "ready" || checkpoints[1].ObservationWindowS != 300 {
		t.Fatalf("checkpoints = %#v", checkpoints)
	}
}

func TestAppendProcessForecastsPreservesExisting(t *testing.T) {
	store := &fakeDocumentStore{documents: map[string]interface{}{
		"runs/run-1": models.RunDoc{ProcessForecasts: []models.ProcessForecast{{ProcessName: "GradleDaemon"}}},
	}}
	client := newStorageClient(store)
	if err := client.AppendProcessForecasts("run-1", []models.ProcessForecast{{ProcessName: "KotlinCompileDaemon"}}); err != nil {
		t.Fatal(err)
	}

	fields := store.writes[0].data.(map[string]interface{})
	forecasts := fields["process_forecasts"].([]models.ProcessForecast)
	if len(forecasts) != 2 || forecasts[0].ProcessName != "GradleDaemon" || forecasts[1].ProcessName != "KotlinCompileDaemon" {
		t.Fatalf("forecasts = %#v", forecasts)
	}
}

func TestStoreSamplesAppendsToRun(t *testing.T) {
	store := &fakeDocumentStore{documents: map[string]interface{}{
		"runs/run-1": models.RunDoc{
			RunID:     "run-1",
			StartTime: time.Unix(1, 0),
			Samples:   []models.Sample{{ElapsedTime: 1}},
		},
	}}
	client := newStorageClient(store)
	if err := client.StoreSamples("run-1", []models.Sample{{ElapsedTime: 2}}); err != nil {
		t.Fatal(err)
	}

	written := store.writes[0].data.(models.RunDoc)
	if len(written.Samples) != 2 || written.Samples[0].ElapsedTime != 1 || written.Samples[1].ElapsedTime != 2 {
		t.Fatalf("samples = %#v", written.Samples)
	}
	if written.UpdatedAtTimestamp == 0 {
		t.Fatal("updated timestamp was not set")
	}
}

func TestStoreProcessInfoUpdatesExistingDocument(t *testing.T) {
	store := &fakeDocumentStore{documents: map[string]interface{}{
		"processes/run-1": models.ProcessDoc{
			RunID:       "run-1",
			ProcessInfo: map[string]models.ProcessInfo{"1": {PID: "1", Name: "old"}},
		},
	}}
	client := newStorageClient(store)
	if err := client.StoreProcessInfo("run-1", models.ProcessInfo{PID: "1", Name: "GradleDaemon"}); err != nil {
		t.Fatal(err)
	}

	written := store.writes[0].data.(models.ProcessDoc)
	if len(written.ProcessInfo) != 1 || written.ProcessInfo["1"].Name != "GradleDaemon" {
		t.Fatalf("process info = %#v", written.ProcessInfo)
	}
}

func TestMarkRunAsFinishedWritesMergeFields(t *testing.T) {
	store := &fakeDocumentStore{documents: map[string]interface{}{
		"runs/run-1": models.RunDoc{RunID: "run-1", StartTime: time.Unix(1, 0), CreatedAt: time.Unix(1, 0)},
	}}
	client := newStorageClient(store)
	newlyFinished, err := client.MarkRunAsFinished("run-1")
	if err != nil {
		t.Fatal(err)
	}
	if !newlyFinished {
		t.Fatal("newlyFinished = false, want true")
	}
	fields := store.writes[0].data.(map[string]interface{})
	if fields["finished"] != true || fields["run_id"] != "run-1" || !store.writes[0].merge {
		t.Fatalf("finish write = %#v", store.writes[0])
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
