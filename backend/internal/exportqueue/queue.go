package exportqueue

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/models"
)

// RunGetter loads a run document (typically from Firestore) using the given context.
type RunGetter func(ctx context.Context, runID string) (*models.RunDoc, error)

// ProcessGetter loads processes/{runID} (JVM flags). Nil skips process export.
type ProcessGetter func(ctx context.Context, runID string) (*models.ProcessDoc, error)

// RunExporter streams a finished run to BigQuery (implemented by *bigqueryexport.Exporter).
type RunExporter interface {
	ExportRun(ctx context.Context, runID string, samples []models.Sample, finishedAt time.Time) error
	ExportProcesses(ctx context.Context, runID string, proc *models.ProcessDoc, finishedAt time.Time) error
}

// Scheduler runs BigQuery exports that re-read Firestore before insert.
type Scheduler struct {
	exp          RunExporter
	getRun       RunGetter
	getProcesses ProcessGetter
	mu           sync.Mutex
	scheduled    map[string]struct{}
}

// New returns a scheduler. If exp is nil or getRun is nil, Run is a no-op. getProcesses may be nil.
func New(exp RunExporter, getRun RunGetter, getProcesses ProcessGetter) *Scheduler {
	return &Scheduler{
		exp:          exp,
		getRun:       getRun,
		getProcesses: getProcesses,
		scheduled:    make(map[string]struct{}),
	}
}

// Run exports runID synchronously. Keeping this work in the request path avoids
// relying on Cloud Run CPU after an HTTP response has been sent.
func (s *Scheduler) Run(runID string) {
	if s == nil || s.exp == nil || s.getRun == nil || runID == "" {
		return
	}
	if !s.markScheduled(runID) {
		log.Printf("BigQuery export already scheduled for %s; skipping duplicate request", runID)
		return
	}
	if !s.exportRunWithRetries(runID) {
		s.clearScheduled(runID)
	}
}

func (s *Scheduler) markScheduled(runID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.scheduled[runID]; ok {
		return false
	}
	s.scheduled[runID] = struct{}{}
	return true
}

func (s *Scheduler) clearScheduled(runID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.scheduled, runID)
}

func procRowCount(p *models.ProcessDoc) int {
	if p == nil {
		return 0
	}
	return len(p.ProcessInfo)
}

func (s *Scheduler) exportRunWithRetries(runID string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	var lastErr error
	samplesExported := false
	processesExported := false
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				log.Printf("BigQuery export for %s: context done before retry: %v", runID, ctx.Err())
				return false
			case <-time.After(time.Duration(1<<uint(attempt-1)) * time.Second):
			}
		}

		doc, err := s.getRun(ctx, runID)
		if err != nil {
			lastErr = err
			log.Printf("BigQuery export attempt %d: GetRun %s: %v", attempt+1, runID, err)
			continue
		}
		if !doc.ExportToBigquery {
			log.Printf("BigQuery export skipped for %s (export_to_bigquery not set)", runID)
			return true
		}
		if !doc.Finished {
			log.Printf("BigQuery export skipped for %s (run not finished in Firestore)", runID)
			return true
		}

		finishedAt := doc.FinishedAt
		if finishedAt.IsZero() {
			finishedAt = doc.UpdatedAt
		}

		var procDoc *models.ProcessDoc
		if s.getProcesses != nil {
			procDoc, err = s.getProcesses(ctx, runID)
			if err != nil {
				lastErr = err
				log.Printf("BigQuery export attempt %d: GetProcesses %s: %v", attempt+1, runID, err)
				continue
			}
		}

		hasSamples := len(doc.Samples) > 0
		hasProcs := procDoc != nil && len(procDoc.ProcessInfo) > 0
		if !hasSamples && !hasProcs {
			log.Printf("BigQuery export skipped for %s (no samples and no process metadata)", runID)
			return true
		}

		if hasSamples && !samplesExported {
			err = s.exp.ExportRun(ctx, runID, doc.Samples, finishedAt)
			if err != nil {
				lastErr = err
				log.Printf("BigQuery export attempt %d failed (samples) for %s: %v", attempt+1, runID, err)
				continue
			}
			samplesExported = true
		}
		if hasProcs && !processesExported {
			err = s.exp.ExportProcesses(ctx, runID, procDoc, finishedAt)
			if err != nil {
				lastErr = err
				log.Printf("BigQuery export attempt %d failed (processes) for %s: %v", attempt+1, runID, err)
				continue
			}
			processesExported = true
		}

		log.Printf("✅ BigQuery export completed for %s (samples=%d process_rows=%d, read from Firestore)",
			runID, len(doc.Samples), procRowCount(procDoc))
		return true
	}
	log.Printf("❌ BigQuery export exhausted retries for %s: %v", runID, lastErr)
	return false
}
