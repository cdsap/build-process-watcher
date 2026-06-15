package bigqueryexport

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"time"

	"cloud.google.com/go/bigquery"
	"github.com/cdsap/build-process-watcher/backend/internal/models"
)

// Exporter streams finished-run samples and process/JVM metadata into BigQuery. Nil or disabled when dataset is empty.
type Exporter struct {
	client         *bigquery.Client
	dataset        string
	samplesTable   string
	processesTable string
}

// New creates an exporter for the given dataset. samplesTable and processesTable default to build_process_samples / build_process_processes when empty.
func New(ctx context.Context, projectID, dataset, samplesTable, processesTable string) (*Exporter, error) {
	dataset = strings.TrimSpace(dataset)
	samplesTable = strings.TrimSpace(samplesTable)
	processesTable = strings.TrimSpace(processesTable)
	if dataset == "" {
		return nil, nil
	}
	if samplesTable == "" {
		samplesTable = "build_process_samples"
	}
	if processesTable == "" {
		processesTable = "build_process_processes"
	}
	client, err := bigquery.NewClient(ctx, projectID)
	if err != nil {
		return nil, fmt.Errorf("bigquery client: %w", err)
	}
	return &Exporter{
		client:         client,
		dataset:        dataset,
		samplesTable:   samplesTable,
		processesTable: processesTable,
	}, nil
}

// Close releases the BigQuery client.
func (e *Exporter) Close() error {
	if e == nil || e.client == nil {
		return nil
	}
	return e.client.Close()
}

// sampleRow matches schema in schema/bigquery_build_process_samples.sql
type sampleRow struct {
	RunID                      string             `bigquery:"run_id"`
	SampleTimestamp            time.Time          `bigquery:"sample_timestamp"`
	ElapsedTime                int64              `bigquery:"elapsed_time"`
	PID                        string             `bigquery:"pid"`
	Name                       string             `bigquery:"name"`
	HeapUsedMB                 int64              `bigquery:"heap_used"`
	HeapCapMB                  int64              `bigquery:"heap_cap"`
	RSSMB                      int64              `bigquery:"rss"`
	GCTimeMS                   int64              `bigquery:"gc_time"`
	JITCompiledMethods         bigquery.NullInt64 `bigquery:"jit_compiled_methods"`
	JITFailedCompilations      bigquery.NullInt64 `bigquery:"jit_failed_compilations"`
	JITInvalidatedCompilations bigquery.NullInt64 `bigquery:"jit_invalidated_compilations"`
	JITCompilationTimeMs       bigquery.NullInt64 `bigquery:"jit_compilation_time_ms"`
	ClassesLoaded              bigquery.NullInt64 `bigquery:"classes_loaded"`
	ClassesUnloaded            bigquery.NullInt64 `bigquery:"classes_unloaded"`
	ClassLoadTimeMs            bigquery.NullInt64 `bigquery:"class_load_time_ms"`
	RunFinishedAt              time.Time          `bigquery:"run_finished_at"`
}

func optionalInt64(value *int) bigquery.NullInt64 {
	if value == nil {
		return bigquery.NullInt64{}
	}
	return bigquery.NullInt64{Int64: int64(*value), Valid: true}
}

// ExportRun inserts all samples for a finished run. Errors do not rollback Firestore; callers log and continue.
func (e *Exporter) ExportRun(ctx context.Context, runID string, samples []models.Sample, finishedAt time.Time) error {
	if e == nil || e.client == nil || len(samples) == 0 {
		return nil
	}
	rows := make([]*bigquery.StructSaver, 0, len(samples))
	for i, s := range samples {
		ts := time.UnixMilli(s.Timestamp).UTC()
		row := sampleRow{
			RunID:                      runID,
			SampleTimestamp:            ts,
			ElapsedTime:                int64(s.ElapsedTime),
			PID:                        s.PID,
			Name:                       s.Name,
			HeapUsedMB:                 int64(s.HeapUsed),
			HeapCapMB:                  int64(s.HeapCap),
			RSSMB:                      int64(s.RSS),
			GCTimeMS:                   int64(s.GCTime),
			JITCompiledMethods:         optionalInt64(s.JITCompiledMethods),
			JITFailedCompilations:      optionalInt64(s.JITFailedCompilations),
			JITInvalidatedCompilations: optionalInt64(s.JITInvalidatedCompilations),
			JITCompilationTimeMs:       optionalInt64(s.JITCompilationTimeMs),
			ClassesLoaded:              optionalInt64(s.ClassesLoaded),
			ClassesUnloaded:            optionalInt64(s.ClassesUnloaded),
			ClassLoadTimeMs:            optionalInt64(s.ClassLoadTimeMs),
			RunFinishedAt:              finishedAt.UTC(),
		}
		rows = append(rows, &bigquery.StructSaver{
			InsertID: stableInsertID("sample", runID, i, s.Timestamp, s.ElapsedTime, s.PID, s.Name),
			Struct:   row,
		})
	}
	inserter := e.client.Dataset(e.dataset).Table(e.samplesTable).Inserter()
	if err := inserter.Put(ctx, rows); err != nil {
		return fmt.Errorf("bigquery insert samples: %w", err)
	}
	return nil
}

// processRow matches schema/bigquery_build_process_processes.sql
type processRow struct {
	RunID         string    `bigquery:"run_id"`
	PID           string    `bigquery:"pid"`
	Name          string    `bigquery:"name"`
	VMFlags       []string  `bigquery:"vm_flags"`
	RunFinishedAt time.Time `bigquery:"run_finished_at"`
}

// ExportProcesses inserts one row per JVM process (VM flags from jinfo). No-op when proc is nil or empty.
func (e *Exporter) ExportProcesses(ctx context.Context, runID string, proc *models.ProcessDoc, finishedAt time.Time) error {
	if e == nil || e.client == nil || e.processesTable == "" {
		return nil
	}
	if proc == nil || len(proc.ProcessInfo) == 0 {
		return nil
	}
	keys := make([]string, 0, len(proc.ProcessInfo))
	for key := range proc.ProcessInfo {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	rows := make([]*bigquery.StructSaver, 0, len(proc.ProcessInfo))
	for _, key := range keys {
		info := proc.ProcessInfo[key]
		flags := info.VMFlags
		if flags == nil {
			flags = []string{}
		}
		pid := info.PID
		if pid == "" {
			pid = "unknown"
		}
		row := processRow{
			RunID:         runID,
			PID:           pid,
			Name:          info.Name,
			VMFlags:       flags,
			RunFinishedAt: finishedAt.UTC(),
		}
		rows = append(rows, &bigquery.StructSaver{
			InsertID: stableInsertID("process", runID, key, pid, info.Name),
			Struct:   row,
		})
	}
	inserter := e.client.Dataset(e.dataset).Table(e.processesTable).Inserter()
	if err := inserter.Put(ctx, rows); err != nil {
		return fmt.Errorf("bigquery insert processes: %w", err)
	}
	return nil
}

func stableInsertID(prefix string, parts ...interface{}) string {
	h := sha256.New()
	for _, part := range parts {
		_, _ = fmt.Fprintf(h, "\x00%v", part)
	}
	return prefix + ":" + hex.EncodeToString(h.Sum(nil))
}
