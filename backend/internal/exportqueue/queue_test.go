package exportqueue

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/models"
)

type recordingExporter struct {
	mu              sync.Mutex
	exportCalls     int
	procExportCalls int
	lastRunID       string
	lastSampleN     int
	lastFinished    time.Time
	lastProcKeys    int
	failRemaining   int
	failProcRemain  int
}

func (r *recordingExporter) ExportRun(ctx context.Context, runID string, samples []models.Sample, finishedAt time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.exportCalls++
	r.lastRunID = runID
	r.lastSampleN = len(samples)
	r.lastFinished = finishedAt
	if r.failRemaining > 0 {
		r.failRemaining--
		return errors.New("transient export error")
	}
	return nil
}

func (r *recordingExporter) ExportProcesses(ctx context.Context, runID string, proc *models.ProcessDoc, finishedAt time.Time) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.procExportCalls++
	if proc != nil {
		r.lastProcKeys = len(proc.ProcessInfo)
	}
	if r.failProcRemain > 0 {
		r.failProcRemain--
		return errors.New("transient process export error")
	}
	return nil
}

func (r *recordingExporter) exportCallsCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.exportCalls
}

func (r *recordingExporter) procExportCallsCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.procExportCalls
}

func processDocWithFlags(runID string, pid, name string, flags []string) *models.ProcessDoc {
	return &models.ProcessDoc{
		RunID: runID,
		ProcessInfo: map[string]models.ProcessInfo{
			pid: {PID: pid, Name: name, VMFlags: flags},
		},
	}
}

func sampleDoc(export bool, finished bool, samples int) *models.RunDoc {
	fin := time.Date(2026, 4, 2, 12, 0, 0, 0, time.UTC)
	doc := &models.RunDoc{
		RunID:            "run-a",
		ExportToBigquery: export,
		Finished:         finished,
		FinishedAt:       fin,
		UpdatedAt:        fin,
		Samples:          make([]models.Sample, samples),
	}
	for i := 0; i < samples; i++ {
		doc.Samples[i] = models.Sample{PID: "1", Name: "GradleDaemon"}
	}
	return doc
}

func Test_exportRunWithRetries_skipsWithoutExportFlag(t *testing.T) {
	exp := &recordingExporter{}
	s := New(exp, func(ctx context.Context, runID string) (*models.RunDoc, error) {
		return sampleDoc(false, true, 3), nil
	}, nil)
	s.exportRunWithRetries("run-a")
	if exp.exportCallsCount() != 0 || exp.procExportCallsCount() != 0 {
		t.Fatalf("expected no export, runs=%d procs=%d", exp.exportCallsCount(), exp.procExportCallsCount())
	}
}

func Test_exportRunWithRetries_skipsWhenNotFinished(t *testing.T) {
	exp := &recordingExporter{}
	s := New(exp, func(ctx context.Context, runID string) (*models.RunDoc, error) {
		return sampleDoc(true, false, 3), nil
	}, nil)
	s.exportRunWithRetries("run-a")
	if exp.exportCallsCount() != 0 {
		t.Fatalf("expected no ExportRun, got %d", exp.exportCallsCount())
	}
}

func Test_exportRunWithRetries_skipsWhenNoSamples(t *testing.T) {
	exp := &recordingExporter{}
	s := New(exp, func(ctx context.Context, runID string) (*models.RunDoc, error) {
		return sampleDoc(true, true, 0), nil
	}, nil)
	s.exportRunWithRetries("run-a")
	if exp.exportCallsCount() != 0 || exp.procExportCallsCount() != 0 {
		t.Fatalf("expected no export, runs=%d procs=%d", exp.exportCallsCount(), exp.procExportCallsCount())
	}
}

func Test_exportRunWithRetries_exportsProcessesWhenNoSamples(t *testing.T) {
	exp := &recordingExporter{}
	s := New(exp,
		func(ctx context.Context, runID string) (*models.RunDoc, error) {
			return sampleDoc(true, true, 0), nil
		},
		func(ctx context.Context, runID string) (*models.ProcessDoc, error) {
			return processDocWithFlags(runID, "4242", "GradleDaemon", []string{"-XX:+UseG1GC"}), nil
		},
	)
	s.exportRunWithRetries("run-a")
	if exp.exportCallsCount() != 0 {
		t.Fatalf("ExportRun calls = %d, want 0", exp.exportCallsCount())
	}
	if exp.procExportCallsCount() != 1 {
		t.Fatalf("ExportProcesses calls = %d, want 1", exp.procExportCallsCount())
	}
	exp.mu.Lock()
	if exp.lastProcKeys != 1 {
		t.Fatalf("process rows = %d", exp.lastProcKeys)
	}
	exp.mu.Unlock()
}

func Test_exportRunWithRetries_exportsSamplesAndProcesses(t *testing.T) {
	exp := &recordingExporter{}
	s := New(exp,
		func(ctx context.Context, runID string) (*models.RunDoc, error) {
			return sampleDoc(true, true, 1), nil
		},
		func(ctx context.Context, runID string) (*models.ProcessDoc, error) {
			return processDocWithFlags(runID, "1", "GradleDaemon", []string{"-XX:+UseG1GC"}), nil
		},
	)
	s.exportRunWithRetries("run-a")
	if exp.exportCallsCount() != 1 || exp.procExportCallsCount() != 1 {
		t.Fatalf("runs=%d procs=%d", exp.exportCallsCount(), exp.procExportCallsCount())
	}
}

func Test_exportRunWithRetries_callsExportWithFirestoreSnapshot(t *testing.T) {
	doc := sampleDoc(true, true, 2)
	exp := &recordingExporter{}
	s := New(exp, func(ctx context.Context, runID string) (*models.RunDoc, error) {
		if runID != "run-a" {
			t.Fatalf("runID %q", runID)
		}
		return doc, nil
	}, nil)
	s.exportRunWithRetries("run-a")
	if exp.exportCallsCount() != 1 {
		t.Fatalf("ExportRun calls = %d", exp.exportCallsCount())
	}
	if exp.procExportCallsCount() != 0 {
		t.Fatalf("unexpected ExportProcesses: %d", exp.procExportCallsCount())
	}
	exp.mu.Lock()
	defer exp.mu.Unlock()
	if exp.lastRunID != "run-a" || exp.lastSampleN != 2 {
		t.Fatalf("ExportRun args: runID=%s samples=%d", exp.lastRunID, exp.lastSampleN)
	}
	if !exp.lastFinished.Equal(doc.FinishedAt) {
		t.Fatalf("finishedAt mismatch: %v vs %v", exp.lastFinished, doc.FinishedAt)
	}
}

func Test_exportRunWithRetries_usesUpdatedAtWhenFinishedAtZero(t *testing.T) {
	upd := time.Date(2026, 4, 2, 15, 30, 0, 0, time.UTC)
	doc := sampleDoc(true, true, 1)
	doc.FinishedAt = time.Time{}
	doc.UpdatedAt = upd
	exp := &recordingExporter{}
	s := New(exp, func(ctx context.Context, runID string) (*models.RunDoc, error) {
		return doc, nil
	}, nil)
	s.exportRunWithRetries("run-a")
	exp.mu.Lock()
	defer exp.mu.Unlock()
	if !exp.lastFinished.Equal(upd) {
		t.Fatalf("expected UpdatedAt fallback %v, got %v", upd, exp.lastFinished)
	}
}

func Test_exportRunWithRetries_retriesThenSucceeds(t *testing.T) {
	exp := &recordingExporter{failRemaining: 2}
	s := New(exp, func(ctx context.Context, runID string) (*models.RunDoc, error) {
		return sampleDoc(true, true, 1), nil
	}, nil)
	s.exportRunWithRetries("run-a")
	if exp.exportCallsCount() != 3 {
		t.Fatalf("expected 3 ExportRun attempts, got %d", exp.exportCallsCount())
	}
}

func Test_exportRunWithRetries_doesNotReexportSamplesWhenProcessRetryFails(t *testing.T) {
	exp := &recordingExporter{failProcRemain: 2}
	s := New(exp,
		func(ctx context.Context, runID string) (*models.RunDoc, error) {
			return sampleDoc(true, true, 1), nil
		},
		func(ctx context.Context, runID string) (*models.ProcessDoc, error) {
			return processDocWithFlags(runID, "1", "GradleDaemon", []string{"-XX:+UseG1GC"}), nil
		},
	)
	s.exportRunWithRetries("run-a")
	if got := exp.exportCallsCount(); got != 1 {
		t.Fatalf("ExportRun calls = %d, want 1", got)
	}
	if got := exp.procExportCallsCount(); got != 3 {
		t.Fatalf("ExportProcesses calls = %d, want 3", got)
	}
}

func Test_exportRunWithRetries_retriesGetRun(t *testing.T) {
	var getN atomic.Int32
	exp := &recordingExporter{}
	s := New(exp, func(ctx context.Context, runID string) (*models.RunDoc, error) {
		n := getN.Add(1)
		if n < 3 {
			return nil, errors.New("rpc down")
		}
		return sampleDoc(true, true, 1), nil
	}, nil)
	s.exportRunWithRetries("run-a")
	if getN.Load() != 3 {
		t.Fatalf("GetRun attempts = %d", getN.Load())
	}
	if exp.exportCallsCount() != 1 {
		t.Fatalf("ExportRun calls = %d", exp.exportCallsCount())
	}
}

func Test_Run_doubleDoesNotDoubleExport(t *testing.T) {
	exp := &recordingExporter{}
	s := New(exp, func(ctx context.Context, runID string) (*models.RunDoc, error) {
		return sampleDoc(true, true, 1), nil
	}, nil)

	go func() { s.Run("run-sf") }()
	go func() { s.Run("run-sf") }()

	deadline := time.After(3 * time.Second)
	for exp.exportCallsCount() < 1 {
		select {
		case <-deadline:
			t.Fatalf("timed out waiting export, ExportRun calls=%d", exp.exportCallsCount())
		default:
			time.Sleep(5 * time.Millisecond)
		}
	}
	time.Sleep(50 * time.Millisecond)
	if got := exp.exportCallsCount(); got != 1 {
		t.Fatalf("ExportRun calls = %d, want 1 (singleflight should coalesce)", got)
	}
}

func Test_New_RunNoPanicsWhenUnconfigured(t *testing.T) {
	s := New(nil, func(ctx context.Context, runID string) (*models.RunDoc, error) {
		return nil, nil
	}, nil)
	s.Run("x") // exp nil

	s2 := New(&recordingExporter{}, nil, nil)
	s2.Run("y") // getRun nil
}

func Test_Run_ignoresEmptyRunID(t *testing.T) {
	exp := &recordingExporter{}
	s := New(exp, func(ctx context.Context, runID string) (*models.RunDoc, error) {
		t.Fatal("getRun should not run")
		return nil, nil
	}, nil)
	s.Run("")
	if exp.exportCallsCount() != 0 {
		t.Fatal("expected no export")
	}
}
