package storage

import (
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/models"
)

func emptyProcessDoc(runID string) *models.ProcessDoc {
	return &models.ProcessDoc{
		RunID:       runID,
		ProcessInfo: make(map[string]models.ProcessInfo),
	}
}

// isRunStale reports whether an unfinished run's UpdatedAt is older than timeout.
func isRunStale(finished bool, updatedAt, now time.Time, timeout time.Duration) bool {
	if finished {
		return false
	}
	return now.Sub(updatedAt) > timeout
}
