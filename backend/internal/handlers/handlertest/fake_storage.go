package handlertest

import (
	"context"
	"fmt"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/models"
	"github.com/cdsap/build-process-watcher/backend/internal/storage"
)

// FakeStorage is a shared in-memory handlers.RunStore double for package tests.
type FakeStorage struct {
	Runs                  map[string]*models.RunDoc
	Processes             map[string]*models.ProcessDoc
	ExportToBigQuery      map[string]bool
	PredictiveReliability map[string]bool
	PredictionModes       map[string]string
	PredictionThrottles   map[string]int
	GetRunErr             error
	StoredSamples         []models.Sample
	StoredProcessInfo     []models.ProcessInfo
	AppendedForecasts     []models.ProcessForecast
	FinishedRuns          []string
	GetRunCalls           int
	GetProcessesCalls     int
	LastCtx               context.Context
}

// NewFakeStorage returns an empty FakeStorage.
func NewFakeStorage() *FakeStorage {
	return &FakeStorage{
		Runs:                  make(map[string]*models.RunDoc),
		Processes:             make(map[string]*models.ProcessDoc),
		ExportToBigQuery:      make(map[string]bool),
		PredictiveReliability: make(map[string]bool),
		PredictionModes:       make(map[string]string),
		PredictionThrottles:   make(map[string]int),
	}
}

func (f *FakeStorage) GetRun(ctx context.Context, runID string) (*models.RunDoc, error) {
	f.LastCtx = ctx
	f.GetRunCalls++
	if f.GetRunErr != nil {
		return nil, f.GetRunErr
	}
	run, ok := f.Runs[runID]
	if !ok {
		return nil, fmt.Errorf("%w: %s", storage.ErrRunNotFound, runID)
	}
	return run, nil
}

func (f *FakeStorage) GetProcesses(ctx context.Context, runID string) (*models.ProcessDoc, error) {
	f.LastCtx = ctx
	f.GetProcessesCalls++
	processes, ok := f.Processes[runID]
	if !ok {
		return nil, fmt.Errorf("processes for run %s not found", runID)
	}
	return processes, nil
}

func (f *FakeStorage) AppendSamples(_ context.Context, runID string, build storage.SampleBuildFunc) (*storage.SampleAppendResult, error) {
	existing := f.Runs[runID]
	startTime := time.Now()
	if existing != nil && !existing.StartTime.IsZero() {
		startTime = existing.StartTime
	}
	samples, err := build(startTime)
	if err != nil {
		return nil, err
	}
	f.StoredSamples = append(f.StoredSamples, samples...)
	if existing == nil {
		existing = &models.RunDoc{RunID: runID, StartTime: startTime}
		f.Runs[runID] = existing
	}
	existing.Samples = append(existing.Samples, samples...)
	return &storage.SampleAppendResult{
		Count:                 len(samples),
		PredictionMode:        existing.PredictionMode,
		PredictionThrottleS:   existing.PredictionThrottleS,
		PredictiveReliability: existing.PredictiveReliability,
	}, nil
}

func (f *FakeStorage) StoreProcessInfo(_ context.Context, runID string, processInfo models.ProcessInfo) error {
	f.StoredProcessInfo = append(f.StoredProcessInfo, processInfo)
	processes := f.Processes[runID]
	if processes == nil {
		processes = &models.ProcessDoc{RunID: runID, ProcessInfo: make(map[string]models.ProcessInfo)}
		f.Processes[runID] = processes
	}
	processes.ProcessInfo[processInfo.PID] = processInfo
	return nil
}

func (f *FakeStorage) StorePredictionCheckpoint(context.Context, string, models.PredictionCheckpoint) error {
	return nil
}

func (f *FakeStorage) AppendProcessForecasts(_ context.Context, _ string, forecasts []models.ProcessForecast) error {
	f.AppendedForecasts = append(f.AppendedForecasts, forecasts...)
	return nil
}

func (f *FakeStorage) SetRunExportToBigquery(_ context.Context, runID string, enabled bool) error {
	f.ExportToBigQuery[runID] = enabled
	return nil
}

func (f *FakeStorage) SetRunPredictiveReliability(_ context.Context, runID string, enabled bool) error {
	f.PredictiveReliability[runID] = enabled
	return nil
}

func (f *FakeStorage) SetRunPredictionMode(_ context.Context, runID, mode string) error {
	f.PredictionModes[runID] = mode
	if run := f.Runs[runID]; run != nil {
		run.PredictionMode = mode
	}
	return nil
}

func (f *FakeStorage) SetRunPredictionThrottleS(_ context.Context, runID string, throttleS int) error {
	throttleS = models.NormalizeThrottleElapsedS(throttleS)
	f.PredictionThrottles[runID] = throttleS
	if run := f.Runs[runID]; run != nil {
		run.PredictionThrottleS = throttleS
	} else {
		f.Runs[runID] = &models.RunDoc{RunID: runID, PredictionThrottleS: throttleS}
	}
	return nil
}

func (f *FakeStorage) MarkRunAsFinished(_ context.Context, runID string) (bool, error) {
	run, ok := f.Runs[runID]
	if !ok {
		return false, fmt.Errorf("%w: %s", storage.ErrRunNotFound, runID)
	}
	if run.Finished {
		return false, nil
	}
	run.Finished = true
	run.FinishedAt = time.Now()
	f.FinishedRuns = append(f.FinishedRuns, runID)
	return true, nil
}

func (f *FakeStorage) SetRunPredictionTarget(_ context.Context, runID, target string) error {
	if f.Runs[runID] == nil {
		f.Runs[runID] = &models.RunDoc{RunID: runID}
	}
	f.Runs[runID].PredictionTarget = target
	return nil
}
func (f *FakeStorage) AppendProcessActivityForecasts(_ context.Context, runID string, values []models.ProcessActivityForecast) error {
	if f.Runs[runID] != nil {
		f.Runs[runID].ProcessActivityForecasts = models.MergeActivityForecasts(f.Runs[runID].ProcessActivityForecasts, values)
	}
	return nil
}
