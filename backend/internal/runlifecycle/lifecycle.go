package runlifecycle

import (
	"context"
	"fmt"
	"log"
	"time"
)

// DefaultStaleTimeout is how long a run may sit without updates before auto-finish.
const DefaultStaleTimeout = 5 * time.Minute

// Finisher marks a run finished in storage.
type Finisher interface {
	MarkRunAsFinished(ctx context.Context, runID string) (newlyFinished bool, err error)
}

// Exporter schedules post-finish work (e.g. BigQuery export).
type Exporter interface {
	Run(runID string)
}

// StaleFinder lists run IDs that have not been updated within a timeout.
type StaleFinder interface {
	FindStaleRuns(ctx context.Context, timeout time.Duration) ([]string, error)
}

// Service owns finish + optional export triggering for HTTP and cleanup callers.
type Service struct {
	finisher     Finisher
	export       Exporter
	finder       StaleFinder
	staleTimeout time.Duration
	now          func() time.Time
}

// New builds a lifecycle service for finish/export (no bulk stale scan).
func New(finisher Finisher, export Exporter) *Service {
	return &Service{
		finisher:     finisher,
		export:       export,
		staleTimeout: DefaultStaleTimeout,
		now:          time.Now,
	}
}

// NewWithFinder builds a lifecycle service that can also finish all stale runs.
func NewWithFinder(finisher Finisher, export Exporter, finder StaleFinder) *Service {
	s := New(finisher, export)
	s.finder = finder
	return s
}

// Finish marks the run finished and triggers export when this call transitions it.
func (s *Service) Finish(ctx context.Context, runID string) (newlyFinished bool, err error) {
	if s == nil || s.finisher == nil {
		return false, fmt.Errorf("run lifecycle finisher not configured")
	}
	newlyFinished, err = s.finisher.MarkRunAsFinished(ctx, runID)
	if err != nil {
		return false, err
	}
	if newlyFinished && s.export != nil {
		s.export.Run(runID)
	}
	return newlyFinished, nil
}

// IsStale reports whether an unfinished run has exceeded the stale timeout.
func (s *Service) IsStale(updatedAt time.Time, finished bool) bool {
	if s == nil || finished {
		return false
	}
	timeout := DefaultStaleTimeout
	if s.staleTimeout > 0 {
		timeout = s.staleTimeout
	}
	now := time.Now()
	if s.now != nil {
		now = s.now()
	}
	return now.Sub(updatedAt) > timeout
}

// FinishIfStale finishes the run when it is stale. newlyFinished is true only when
// this call transitioned the run (so callers can refresh in-memory state).
func (s *Service) FinishIfStale(ctx context.Context, runID string, updatedAt time.Time, finished bool) (newlyFinished bool, err error) {
	if !s.IsStale(updatedAt, finished) {
		return false, nil
	}
	log.Printf("Run %s stale for >%s; auto-finishing", runID, s.staleTimeout)
	return s.Finish(ctx, runID)
}

// StaleCleanupResult is the outcome of a bulk stale-finish pass.
type StaleCleanupResult struct {
	StaleFound []string
	Cleaned    []string
}

// FinishAllStale finds and finishes every stale run.
func (s *Service) FinishAllStale(ctx context.Context) (StaleCleanupResult, error) {
	if s == nil || s.finder == nil {
		return StaleCleanupResult{}, fmt.Errorf("run lifecycle stale finder not configured")
	}
	timeout := DefaultStaleTimeout
	if s.staleTimeout > 0 {
		timeout = s.staleTimeout
	}
	staleRuns, err := s.finder.FindStaleRuns(ctx, timeout)
	if err != nil {
		return StaleCleanupResult{}, err
	}
	cleaned := make([]string, 0, len(staleRuns))
	for _, runID := range staleRuns {
		if _, err := s.Finish(ctx, runID); err != nil {
			log.Printf("❌ Error cleaning up stale run %s: %v", runID, err)
			continue
		}
		log.Printf("✅ Successfully marked stale run %s as finished", runID)
		cleaned = append(cleaned, runID)
	}
	return StaleCleanupResult{StaleFound: staleRuns, Cleaned: cleaned}, nil
}
