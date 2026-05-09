package bigqueryexport

import (
	"context"
	"testing"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/models"
)

func TestExporter_ExportRun_nilReceiver(t *testing.T) {
	var e *Exporter
	if err := e.ExportRun(context.Background(), "run-1", []models.Sample{{PID: "1"}}, time.Now()); err != nil {
		t.Fatal(err)
	}
}

func TestExporter_ExportRun_emptySamples(t *testing.T) {
	e := &Exporter{}
	if err := e.ExportRun(context.Background(), "run-1", nil, time.Now()); err != nil {
		t.Fatal(err)
	}
}

func TestExporter_ExportProcesses_nilReceiver(t *testing.T) {
	var e *Exporter
	err := e.ExportProcesses(context.Background(), "run-1", &models.ProcessDoc{
		RunID: "run-1",
		ProcessInfo: map[string]models.ProcessInfo{
			"1": {PID: "1", VMFlags: []string{"-XX:+UseG1GC"}},
		},
	}, time.Now())
	if err != nil {
		t.Fatal(err)
	}
}

func TestExporter_ExportProcesses_unconfiguredClient(t *testing.T) {
	e := &Exporter{processesTable: "t"}
	if err := e.ExportProcesses(context.Background(), "run-1", &models.ProcessDoc{
		ProcessInfo: map[string]models.ProcessInfo{"1": {PID: "1"}},
	}, time.Now()); err != nil {
		t.Fatal(err)
	}
}

func TestExporter_ExportProcesses_emptyDoc(t *testing.T) {
	e := &Exporter{client: nil, processesTable: "t"}
	if err := e.ExportProcesses(context.Background(), "run-1", nil, time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := e.ExportProcesses(context.Background(), "run-1", &models.ProcessDoc{}, time.Now()); err != nil {
		t.Fatal(err)
	}
}

func TestStableInsertID(t *testing.T) {
	a := stableInsertID("sample", "run-1", 0, int64(1234), "1", "GradleDaemon")
	b := stableInsertID("sample", "run-1", 0, int64(1234), "1", "GradleDaemon")
	c := stableInsertID("sample", "run-1", 1, int64(1234), "1", "GradleDaemon")
	if a == "" {
		t.Fatal("expected non-empty insert id")
	}
	if a != b {
		t.Fatalf("insert id should be stable: %q != %q", a, b)
	}
	if a == c {
		t.Fatalf("insert id should change when row identity changes: %q", a)
	}
}
