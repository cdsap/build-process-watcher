package features

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"testing"

	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
)

type fixtureExpectedRow struct {
	SampleCount           int     `json:"sample_count"`
	ProcessCount          int     `json:"process_count"`
	MaxElapsedS           float64 `json:"max_elapsed_s"`
	FirstElapsedS         float64 `json:"first_elapsed_s"`
	PeakRSSMB             float64 `json:"peak_rss_mb"`
	FirstRSSMB            float64 `json:"first_rss_mb"`
	LatestRSSMB           float64 `json:"latest_rss_mb"`
	RSSGrowthMBPerMin     float64 `json:"rss_growth_mb_per_min"`
	HeapUtilization       float64 `json:"heap_utilization"`
	GCTimeRatio           float64 `json:"gc_time_ratio"`
	JITCompiledMethods    *int    `json:"jit_compiled_methods"`
	JITFailedCompilations *int    `json:"jit_failed_compilations"`
	JITCompilationTimeMs  *int    `json:"jit_compilation_time_ms"`
	ClassesLoaded         *int    `json:"classes_loaded"`
	ClassLoadTimeMs       *int    `json:"class_load_time_ms"`
}

type parityFixture struct {
	RunID            string                           `json:"run_id"`
	ProcessInfo      map[string]predictor.ProcessInfo `json:"process_info"`
	Samples          []HistoricalSample               `json:"samples"`
	ExpectedByWindow map[string]fixtureExpectedRow    `json:"expected_by_window"`
}

func TestTrainingAndLiveFeatureParityAcrossCheckpointWindows(t *testing.T) {
	for _, name := range []string{"parity_run.json", "legacy_partial.json"} {
		t.Run(name, func(t *testing.T) {
			fixture := loadParityFixture(t, name)
			snapshot := fixture.toLiveSnapshot()
			historicalSamples := append([]HistoricalSample(nil), fixture.Samples...)

			for _, window := range CheckpointWindows {
				live := FromSnapshot(snapshot, window)
				historical := FromHistorical(fixture.RunID, historicalSamples, len(fixture.ProcessInfo), window)
				if !reflect.DeepEqual(live, historical) {
					t.Fatalf("window %ds live row != historical row\nlive:       %+v\nhistorical: %+v", window, live, historical)
				}

				key := windowKey(window)
				expected, ok := fixture.ExpectedByWindow[key]
				if !ok {
					t.Fatalf("fixture missing expected row for window %s", key)
				}
				assertExpectedRow(t, window, live, expected)

				// Determinism: repeated derivation from the same fixture must match exactly.
				liveAgain := FromSnapshot(snapshot, window)
				historicalAgain := FromHistorical(fixture.RunID, historicalSamples, len(fixture.ProcessInfo), window)
				if !reflect.DeepEqual(live, liveAgain) {
					t.Fatalf("window %ds live derivation is non-deterministic", window)
				}
				if !reflect.DeepEqual(historical, historicalAgain) {
					t.Fatalf("window %ds historical derivation is non-deterministic", window)
				}
			}
		})
	}
}

func TestParityFixtureCoversAllV1CheckpointWindows(t *testing.T) {
	want := []int{60, 300, 600, 1200}
	if !reflect.DeepEqual(CheckpointWindows, want) {
		t.Fatalf("CheckpointWindows = %v, want %v", CheckpointWindows, want)
	}
	for _, name := range []string{"parity_run.json", "legacy_partial.json"} {
		fixture := loadParityFixture(t, name)
		if len(fixture.ExpectedByWindow) != len(want) {
			t.Fatalf("%s expected_by_window size = %d, want %d", name, len(fixture.ExpectedByWindow), len(want))
		}
		for _, window := range want {
			if _, ok := fixture.ExpectedByWindow[windowKey(window)]; !ok {
				t.Fatalf("%s missing expected row for %ds", name, window)
			}
		}
	}
}

func TestRowsIgnoreSamplesAfterCheckpointWindow(t *testing.T) {
	row := FromSnapshot(predictor.RunSnapshot{
		RunID: "run-1",
		Samples: []predictor.Sample{
			{ElapsedTime: 60, RSS: 512, HeapUsed: 300, HeapCap: 1000},
			{ElapsedTime: 61, RSS: 4096, HeapUsed: 990, HeapCap: 1000},
		},
	}, 60)

	if row.SampleCount != 1 {
		t.Fatalf("SampleCount = %d, want 1", row.SampleCount)
	}
	if row.PeakRSSMB != 512 {
		t.Fatalf("PeakRSSMB = %v, want 512", row.PeakRSSMB)
	}
	if row.HeapUtilization != 0.3 {
		t.Fatalf("HeapUtilization = %v, want 0.3", row.HeapUtilization)
	}
}

func TestRowsRemainValidWithMissingOptionalTelemetry(t *testing.T) {
	row := FromSnapshot(predictor.RunSnapshot{
		RunID: "run-1",
		Samples: []predictor.Sample{
			{ElapsedTime: 10},
			{ElapsedTime: 60, RSS: 256},
		},
	}, 60)

	if row.SampleCount != 2 {
		t.Fatalf("SampleCount = %d, want 2", row.SampleCount)
	}
	if row.JITCompiledMethods != nil {
		t.Fatalf("JITCompiledMethods = %v, want nil", row.JITCompiledMethods)
	}
	if row.ClassesLoaded != nil {
		t.Fatalf("ClassesLoaded = %v, want nil", row.ClassesLoaded)
	}
	if row.PeakRSSMB != 256 {
		t.Fatalf("PeakRSSMB = %v, want 256", row.PeakRSSMB)
	}
}

func TestRowsExcludeRawProcessMetadata(t *testing.T) {
	row := FromSnapshot(predictor.RunSnapshot{
		RunID:   "run-1",
		Samples: []predictor.Sample{{ElapsedTime: 60, RSS: 512}},
		ProcessInfo: map[string]predictor.ProcessInfo{
			"1": {PID: "1", Name: "GradleDaemon", VMFlags: []string{"-XX:+UnlockDiagnosticVMOptions", "-Xmx4g"}},
		},
	}, 60)

	if row.ProcessCount != 1 {
		t.Fatalf("ProcessCount = %d, want 1", row.ProcessCount)
	}

	rowValue := reflect.ValueOf(row)
	rowType := rowValue.Type()
	for i := 0; i < rowValue.NumField(); i++ {
		field := rowType.Field(i)
		switch field.Name {
		case "VMFlags", "ProcessName", "Repository", "Branch", "CommitMessage", "TaskName", "Logs":
			t.Fatalf("feature row exposes excluded metadata field %q", field.Name)
		}
	}
}

func loadParityFixture(t *testing.T, name string) parityFixture {
	t.Helper()
	path := filepath.Join("testdata", name)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fixture %s: %v", path, err)
	}
	var fixture parityFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("decode fixture %s: %v", path, err)
	}
	if fixture.RunID == "" {
		t.Fatalf("fixture %s missing run_id", path)
	}
	if len(fixture.Samples) == 0 {
		t.Fatalf("fixture %s has no samples", path)
	}
	return fixture
}

func (f parityFixture) toLiveSnapshot() predictor.RunSnapshot {
	samples := make([]predictor.Sample, 0, len(f.Samples))
	for _, sample := range f.Samples {
		runID := sample.RunID
		if runID == "" {
			runID = f.RunID
		}
		samples = append(samples, predictor.Sample{
			RunID:                 runID,
			ElapsedTime:           sample.ElapsedTime,
			PID:                   sample.PID,
			Name:                  sample.Name,
			HeapUsed:              sample.HeapUsed,
			HeapCap:               sample.HeapCap,
			RSS:                   sample.RSS,
			GCTime:                sample.GCTime,
			JITCompiledMethods:    sample.JITCompiledMethods,
			JITFailedCompilations: sample.JITFailedCompilations,
			JITCompilationTimeMs:  sample.JITCompilationTimeMs,
			ClassesLoaded:         sample.ClassesLoaded,
			ClassLoadTimeMs:       sample.ClassLoadTimeMs,
		})
	}
	return predictor.RunSnapshot{
		RunID:       f.RunID,
		Samples:     samples,
		ProcessInfo: f.ProcessInfo,
	}
}

func assertExpectedRow(t *testing.T, window int, got CheckpointRow, want fixtureExpectedRow) {
	t.Helper()
	if got.ObservationWindowS != window {
		t.Fatalf("window %ds ObservationWindowS = %d", window, got.ObservationWindowS)
	}
	if got.SampleCount != want.SampleCount {
		t.Fatalf("window %ds SampleCount = %d, want %d", window, got.SampleCount, want.SampleCount)
	}
	if got.ProcessCount != want.ProcessCount {
		t.Fatalf("window %ds ProcessCount = %d, want %d", window, got.ProcessCount, want.ProcessCount)
	}
	assertFloat(t, "MaxElapsedS", window, got.MaxElapsedS, want.MaxElapsedS)
	assertFloat(t, "FirstElapsedS", window, got.FirstElapsedS, want.FirstElapsedS)
	assertFloat(t, "PeakRSSMB", window, got.PeakRSSMB, want.PeakRSSMB)
	assertFloat(t, "FirstRSSMB", window, got.FirstRSSMB, want.FirstRSSMB)
	assertFloat(t, "LatestRSSMB", window, got.LatestRSSMB, want.LatestRSSMB)
	assertFloat(t, "RSSGrowthMBPerMin", window, got.RSSGrowthMBPerMin, want.RSSGrowthMBPerMin)
	assertFloat(t, "HeapUtilization", window, got.HeapUtilization, want.HeapUtilization)
	assertFloat(t, "GCTimeRatio", window, got.GCTimeRatio, want.GCTimeRatio)
	assertOptionalInt(t, "JITCompiledMethods", window, got.JITCompiledMethods, want.JITCompiledMethods)
	assertOptionalInt(t, "JITFailedCompilations", window, got.JITFailedCompilations, want.JITFailedCompilations)
	assertOptionalInt(t, "JITCompilationTimeMs", window, got.JITCompilationTimeMs, want.JITCompilationTimeMs)
	assertOptionalInt(t, "ClassesLoaded", window, got.ClassesLoaded, want.ClassesLoaded)
	assertOptionalInt(t, "ClassLoadTimeMs", window, got.ClassLoadTimeMs, want.ClassLoadTimeMs)
}

func assertFloat(t *testing.T, field string, window int, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 1e-12 {
		t.Fatalf("window %ds %s = %v, want %v", window, field, got, want)
	}
}

func assertOptionalInt(t *testing.T, field string, window int, got, want *int) {
	t.Helper()
	switch {
	case got == nil && want == nil:
		return
	case got == nil || want == nil:
		t.Fatalf("window %ds %s = %v, want %v", window, field, got, want)
	case *got != *want:
		t.Fatalf("window %ds %s = %d, want %d", window, field, *got, *want)
	}
}

func windowKey(window int) string {
	return strconv.Itoa(window)
}
