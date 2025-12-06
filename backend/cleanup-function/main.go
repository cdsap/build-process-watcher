package cleanupfunction

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/storage"
)

// PubSubMessage represents a Pub/Sub message
type PubSubMessage struct {
	Data []byte `json:"data"`
}

// CleanupOldData is the entry point for the Cloud Function
// It deletes runs older than 3 hours
// Can be triggered by Pub/Sub or HTTP
func CleanupOldData(ctx context.Context, m PubSubMessage) error {
	// Get project ID from environment
	projectID := os.Getenv("GOOGLE_CLOUD_PROJECT")
	if projectID == "" {
		log.Fatal("GOOGLE_CLOUD_PROJECT environment variable is required")
	}

	// Initialize storage client
	storageClient, err := storage.NewClient(ctx, projectID)
	if err != nil {
		log.Fatalf("Failed to initialize storage: %v", err)
		return err
	}
	defer storageClient.Close()

	// Run cleanup (3 hours retention)
	retentionDuration := 3 * time.Hour

	// Log the trigger message if present
	if len(m.Data) > 0 {
		var triggerData map[string]interface{}
		if err := json.Unmarshal(m.Data, &triggerData); err == nil {
			log.Printf("📨 Received trigger: %v", triggerData)
		}
	}

	log.Printf("🗑️ Starting data retention cleanup (retention: %v)", retentionDuration)
	
	deletedRuns, err := storageClient.DeleteOldRuns(retentionDuration)
	if err != nil {
		log.Printf("❌ Error deleting old runs: %v", err)
		return err
	}

	if len(deletedRuns) > 0 {
		log.Printf("🗑️ Cleaned up %d old runs (older than 3 hours)", len(deletedRuns))
		for _, runID := range deletedRuns {
			log.Printf("   - Deleted: %s", runID)
		}
	} else {
		log.Printf("🗑️ No old data to clean up")
	}

	return nil
}
