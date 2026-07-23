package storage

import (
	"encoding/json"
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

func TestMergePredictionCheckpointAppendsInWindowOrder(t *testing.T) {
	merged := MergePredictionCheckpoint([]models.PredictionCheckpoint{
		{ObservationWindowS: 180, Status: "ready"},
		{ObservationWindowS: 30, Status: "ready"},
	}, models.PredictionCheckpoint{ObservationWindowS: 60, Status: "error"})

	windows := []int{merged[0].ObservationWindowS, merged[1].ObservationWindowS, merged[2].ObservationWindowS}
	expected := []int{30, 60, 180}
	for i := range expected {
		if windows[i] != expected[i] {
			t.Fatalf("windows = %v, want %v", windows, expected)
		}
	}
}

func TestMergePredictionCheckpointReplacesExistingWindow(t *testing.T) {
	merged := MergePredictionCheckpoint([]models.PredictionCheckpoint{
		{ObservationWindowS: 30, Status: "ready"},
		{ObservationWindowS: 60, Status: "ready"},
	}, models.PredictionCheckpoint{ObservationWindowS: 60, Status: "error"})

	if len(merged) != 2 {
		t.Fatalf("len = %d, want 2", len(merged))
	}
	if merged[1].ObservationWindowS != 60 || merged[1].Status != "error" {
		t.Fatalf("replacement failed: %+v", merged)
	}
}

func assertIntPointer(t *testing.T, name string, value *int, expected int) {
	t.Helper()
	if value == nil || *value != expected {
		t.Fatalf("%s: expected %d, got %v", name, expected, value)
	}
}
