package features

import (
	"math"
	"sort"

	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
)

// CheckpointWindows is the private v1 checkpoint set shared by training and live scoring.
var CheckpointWindows = []int{60, 300, 600, 1200}

// CheckpointRow is the private derived-feature contract shared by training and live scoring.
type CheckpointRow struct {
	RunID                 string
	ObservationWindowS    int
	SampleCount           int
	ProcessCount          int
	MaxElapsedS           float64
	FirstElapsedS         float64
	PeakRSSMB             float64
	FirstRSSMB            float64
	LatestRSSMB           float64
	RSSGrowthMBPerMin     float64
	HeapUtilization       float64
	GCTimeRatio           float64
	JITCompiledMethods    *int
	JITFailedCompilations *int
	JITCompilationTimeMs  *int
	ClassesLoaded         *int
	ClassLoadTimeMs       *int
}

// HistoricalSample is the finished-run telemetry shape used by private training extraction.
type HistoricalSample struct {
	RunID                 string `json:"run_id,omitempty"`
	ElapsedTime           int    `json:"elapsed_time"`
	PID                   string `json:"pid,omitempty"`
	Name                  string `json:"name,omitempty"`
	HeapUsed              int    `json:"heap_used,omitempty"`
	HeapCap               int    `json:"heap_cap,omitempty"`
	RSS                   int    `json:"rss,omitempty"`
	GCTime                int    `json:"gc_time,omitempty"`
	JITCompiledMethods    *int   `json:"jit_compiled_methods,omitempty"`
	JITFailedCompilations *int   `json:"jit_failed_compilations,omitempty"`
	JITCompilationTimeMs  *int   `json:"jit_compilation_time_ms,omitempty"`
	ClassesLoaded         *int   `json:"classes_loaded,omitempty"`
	ClassLoadTimeMs       *int   `json:"class_load_time_ms,omitempty"`
}

// FromSnapshot derives one checkpoint row from live Firestore-backed public telemetry.
func FromSnapshot(snapshot predictor.RunSnapshot, observationWindowS int) CheckpointRow {
	return build(snapshot.RunID, observationWindowS, snapshot.Samples, len(snapshot.ProcessInfo))
}

// FromHistorical derives one checkpoint row from finished-run training telemetry.
func FromHistorical(runID string, samples []HistoricalSample, processCount int, observationWindowS int) CheckpointRow {
	liveSamples := make([]predictor.Sample, 0, len(samples))
	for _, sample := range samples {
		sampleRunID := sample.RunID
		if sampleRunID == "" {
			sampleRunID = runID
		}
		liveSamples = append(liveSamples, predictor.Sample{
			RunID:                 sampleRunID,
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
	return build(runID, observationWindowS, liveSamples, processCount)
}

func build(runID string, observationWindowS int, samples []predictor.Sample, processCount int) CheckpointRow {
	row := CheckpointRow{
		RunID:              runID,
		ObservationWindowS: observationWindowS,
		ProcessCount:       processCount,
	}
	if observationWindowS <= 0 {
		return row
	}

	windowSamples := samplesWithinWindow(samples, observationWindowS)
	row.SampleCount = len(windowSamples)

	var firstRSSSet bool
	maxGCTimeMs := 0
	for _, sample := range windowSamples {
		elapsed := float64(sample.ElapsedTime)
		// Public run telemetry already stores RSS in megabytes.
		rssMB := float64(sample.RSS)
		if sample.RSS > 0 && (!firstRSSSet || elapsed < row.FirstElapsedS) {
			row.FirstElapsedS = elapsed
			row.FirstRSSMB = rssMB
			firstRSSSet = true
		}
		if elapsed >= row.MaxElapsedS {
			row.MaxElapsedS = elapsed
			if sample.RSS > 0 {
				row.LatestRSSMB = rssMB
			}
		}
		if rssMB > row.PeakRSSMB {
			row.PeakRSSMB = rssMB
		}
		if sample.HeapCap > 0 && sample.HeapUsed > 0 {
			row.HeapUtilization = math.Max(row.HeapUtilization, float64(sample.HeapUsed)/float64(sample.HeapCap))
		}
		if sample.GCTime > maxGCTimeMs {
			maxGCTimeMs = sample.GCTime
		}
		row.JITCompiledMethods = latestInt(row.JITCompiledMethods, sample.JITCompiledMethods)
		row.JITFailedCompilations = latestInt(row.JITFailedCompilations, sample.JITFailedCompilations)
		row.JITCompilationTimeMs = latestInt(row.JITCompilationTimeMs, sample.JITCompilationTimeMs)
		row.ClassesLoaded = latestInt(row.ClassesLoaded, sample.ClassesLoaded)
		row.ClassLoadTimeMs = latestInt(row.ClassLoadTimeMs, sample.ClassLoadTimeMs)
	}

	elapsedDelta := row.MaxElapsedS - row.FirstElapsedS
	if elapsedDelta > 0 && firstRSSSet && row.LatestRSSMB > 0 {
		row.RSSGrowthMBPerMin = (row.LatestRSSMB - row.FirstRSSMB) / elapsedDelta * 60.0
	}
	if row.MaxElapsedS > 0 && maxGCTimeMs > 0 {
		row.GCTimeRatio = float64(maxGCTimeMs) / (row.MaxElapsedS * 1000.0)
	}
	return row
}

func samplesWithinWindow(samples []predictor.Sample, observationWindowS int) []predictor.Sample {
	filtered := make([]predictor.Sample, 0, len(samples))
	for _, sample := range samples {
		if sample.ElapsedTime <= observationWindowS {
			filtered = append(filtered, sample)
		}
	}
	sort.SliceStable(filtered, func(i, j int) bool {
		if filtered[i].ElapsedTime == filtered[j].ElapsedTime {
			return filtered[i].PID < filtered[j].PID
		}
		return filtered[i].ElapsedTime < filtered[j].ElapsedTime
	})
	return filtered
}

func latestInt(current, next *int) *int {
	if next == nil {
		return current
	}
	value := *next
	return &value
}
