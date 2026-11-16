package cleanup

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"

	"github.com/cdsap/build-process-watcher/backend/internal/auth"
	"github.com/cdsap/build-process-watcher/backend/internal/exportqueue"
	"github.com/cdsap/build-process-watcher/backend/internal/runlifecycle"
	"github.com/cdsap/build-process-watcher/backend/internal/storage"
)

// BuildTimeout is retained for callers/tests that reference the shared stale window.
const BuildTimeout = runlifecycle.DefaultStaleTimeout

// Service handles cleanup operations
type Service struct {
	lifecycle *runlifecycle.Service
	authn     *auth.Authenticator
}

// NewService creates a new cleanup service. export and authenticator may be nil.
func NewService(storageClient *storage.Client, export *exportqueue.Scheduler, authenticator *auth.Authenticator) *Service {
	var lifecycle *runlifecycle.Service
	if storageClient != nil {
		lifecycle = runlifecycle.NewWithFinder(storageClient, export, storageClient)
	}
	return &Service{lifecycle: lifecycle, authn: authenticator}
}

// HandleManualStaleCleanup handles manual cleanup of stale runs (admin only)
func (s *Service) HandleManualStaleCleanup(w http.ResponseWriter, r *http.Request) {
	log.Printf("cleanupStaleHandler called with method: %s", r.Method)

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

	if s.authn == nil || !s.authn.RequireAdminAuth(r) {
		log.Printf("⚠️  Unauthorized cleanup attempt from %s", r.RemoteAddr)
		http.Error(w, "Unauthorized - admin secret required", http.StatusUnauthorized)
		return
	}

	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "application/json")

	log.Printf("🧹 Manual cleanup triggered...")

	if s.lifecycle == nil {
		http.Error(w, "Cleanup service not configured", http.StatusInternalServerError)
		return
	}

	result, err := s.lifecycle.FinishAllStale(r.Context())
	if err != nil {
		log.Printf("❌ Error finding stale runs: %v", err)
		http.Error(w, fmt.Sprintf("Error finding stale runs: %v", err), http.StatusInternalServerError)
		return
	}

	log.Printf("🧹 Found %d stale runs", len(result.StaleFound))

	response := map[string]interface{}{
		"success":       true,
		"total_checked": len(result.StaleFound),
		"stale_found":   len(result.StaleFound),
		"cleaned_up":    len(result.Cleaned),
		"cleaned_runs":  result.Cleaned,
	}

	if len(result.StaleFound) > 0 {
		log.Printf("🧹 Manual cleanup completed: cleaned up %d stale runs", len(result.Cleaned))
	} else {
		log.Printf("🧹 Manual cleanup completed: no stale runs found")
	}

	json.NewEncoder(w).Encode(response)
}
