package cleanup

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/auth"
	"github.com/cdsap/build-process-watcher/backend/internal/storage"
)

const (
	// BuildTimeout is the timeout for marking builds as finished (5 minutes)
	BuildTimeout = 5 * time.Minute
	// DataRetentionPeriod is the period for retaining data (3 hours)
	DataRetentionPeriod = 3 * time.Hour
)

// Service handles cleanup operations
type Service struct {
	storage *storage.Client
}

// NewService creates a new cleanup service
func NewService(storageClient *storage.Client) *Service {
	return &Service{
		storage: storageClient,
	}
}

// HandleManualStaleCleanup handles manual cleanup of stale runs (admin only)
func (s *Service) HandleManualStaleCleanup(w http.ResponseWriter, r *http.Request) {
	log.Printf("cleanupStaleHandler called with method: %s", r.Method)

	// Handle CORS preflight
	if r.Method == http.MethodOptions {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Admin-Secret")
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Require admin authentication
	if !auth.RequireAdminAuth(r) {
		log.Printf("⚠️  Unauthorized cleanup attempt from %s", r.RemoteAddr)
		http.Error(w, "Unauthorized - admin secret required", http.StatusUnauthorized)
		return
	}

	// Set CORS headers
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "application/json")

	log.Printf("🧹 Manual cleanup triggered...")

	staleRuns, err := s.storage.FindStaleRuns(BuildTimeout)
	if err != nil {
		log.Printf("❌ Error finding stale runs: %v", err)
		http.Error(w, fmt.Sprintf("Error finding stale runs: %v", err), http.StatusInternalServerError)
		return
	}

	log.Printf("🧹 Found %d stale runs", len(staleRuns))

	// Mark stale runs as finished
	var cleanedRuns []string
	for _, runID := range staleRuns {
		err := s.storage.MarkRunAsFinished(runID)
		if err != nil {
			log.Printf("❌ Error cleaning up stale run %s: %v", runID, err)
		} else {
			log.Printf("✅ Successfully marked stale run %s as finished", runID)
			cleanedRuns = append(cleanedRuns, runID)
		}
	}

	response := map[string]interface{}{
		"success":       true,
		"total_checked": len(staleRuns),
		"stale_found":   len(staleRuns),
		"cleaned_up":    len(cleanedRuns),
		"cleaned_runs":  cleanedRuns,
	}

	if len(staleRuns) > 0 {
		log.Printf("🧹 Manual cleanup completed: cleaned up %d stale runs", len(cleanedRuns))
	} else {
		log.Printf("🧹 Manual cleanup completed: no stale runs found")
	}

	json.NewEncoder(w).Encode(response)
}
