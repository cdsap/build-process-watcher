package runlifecycle

import (
	"errors"
	"testing"
	"time"
)

type fakeFinisher struct {
	finished map[string]bool
	err      error
	calls    []string
}

func (f *fakeFinisher) MarkRunAsFinished(runID string) (bool, error) {
	f.calls = append(f.calls, runID)
	if f.err != nil {
		return false, f.err
	}
	if f.finished[runID] {
		return false, nil
	}
	if f.finished == nil {
		f.finished = map[string]bool{}
	}
	f.finished[runID] = true
	return true, nil
}

type fakeExporter struct {
	runs []string
}

func (e *fakeExporter) Run(runID string) {
	e.runs = append(e.runs, runID)
}

type fakeFinder struct {
	ids []string
	err error
}

func (f *fakeFinder) FindStaleRuns(time.Duration) ([]string, error) {
	return f.ids, f.err
}

func TestFinishTriggersExportOnlyOnTransition(t *testing.T) {
	finisher := &fakeFinisher{finished: map[string]bool{"already": true}}
	export := &fakeExporter{}
	svc := New(finisher, export)

	newly, err := svc.Finish("new-run")
	if err != nil || !newly {
		t.Fatalf("Finish new-run: newly=%v err=%v", newly, err)
	}
	if len(export.runs) != 1 || export.runs[0] != "new-run" {
		t.Fatalf("export runs = %v, want [new-run]", export.runs)
	}

	newly, err = svc.Finish("already")
	if err != nil || newly {
		t.Fatalf("Finish already: newly=%v err=%v", newly, err)
	}
	if len(export.runs) != 1 {
		t.Fatalf("export should not re-fire, got %v", export.runs)
	}
}

func TestFinishIfStaleUsesSharedTimeout(t *testing.T) {
	finisher := &fakeFinisher{}
	export := &fakeExporter{}
	svc := New(finisher, export)
	fixed := time.Date(2026, 11, 16, 12, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return fixed }

	updated := fixed.Add(-6 * time.Minute)
	newly, err := svc.FinishIfStale("stale-run", updated, false)
	if err != nil || !newly {
		t.Fatalf("FinishIfStale: newly=%v err=%v", newly, err)
	}
	if len(finisher.calls) != 1 || finisher.calls[0] != "stale-run" {
		t.Fatalf("finisher calls = %v", finisher.calls)
	}

	newly, err = svc.FinishIfStale("fresh-run", fixed.Add(-time.Minute), false)
	if err != nil || newly {
		t.Fatalf("fresh run should not finish: newly=%v err=%v", newly, err)
	}
	newly, err = svc.FinishIfStale("done-run", updated, true)
	if err != nil || newly {
		t.Fatalf("finished run should not re-finish: newly=%v err=%v", newly, err)
	}
}

func TestFinishAllStaleUsesFinderAndExport(t *testing.T) {
	finisher := &fakeFinisher{}
	export := &fakeExporter{}
	finder := &fakeFinder{ids: []string{"a", "b"}}
	svc := NewWithFinder(finisher, export, finder)

	result, err := svc.FinishAllStale()
	if err != nil {
		t.Fatal(err)
	}
	if len(result.StaleFound) != 2 || len(result.Cleaned) != 2 {
		t.Fatalf("result = %+v", result)
	}
	if len(export.runs) != 2 {
		t.Fatalf("export runs = %v, want 2", export.runs)
	}

	finder.err = errors.New("boom")
	if _, err := svc.FinishAllStale(); err == nil {
		t.Fatal("expected finder error")
	}
}

func TestDefaultStaleTimeoutMatchesPriorHardcodedValue(t *testing.T) {
	if DefaultStaleTimeout != 5*time.Minute {
		t.Fatalf("DefaultStaleTimeout = %s, want 5m", DefaultStaleTimeout)
	}
}
