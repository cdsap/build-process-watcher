package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/cdsap/build-process-watcher/backend/internal/auth"
	"github.com/cdsap/build-process-watcher/backend/internal/bigqueryexport"
	"github.com/cdsap/build-process-watcher/backend/internal/cleanup"
	"github.com/cdsap/build-process-watcher/backend/internal/exportqueue"
	"github.com/cdsap/build-process-watcher/backend/internal/handlers"
	"github.com/cdsap/build-process-watcher/backend/internal/storage"
)

func main() {
	ctx := context.Background()

	// Get project ID from environment
	projectID := os.Getenv("GOOGLE_CLOUD_PROJECT")
	if projectID == "" {
		log.Fatal("GOOGLE_CLOUD_PROJECT environment variable is required")
	}

	// Initialize authentication
	auth.Initialize()

	bqDataset := strings.TrimSpace(os.Getenv("BIGQUERY_EXPORT_DATASET"))
	bqTable := strings.TrimSpace(os.Getenv("BIGQUERY_EXPORT_TABLE"))
	bqProcessesTable := strings.TrimSpace(os.Getenv("BIGQUERY_EXPORT_PROCESSES_TABLE"))
	bqExporter, err := bigqueryexport.New(ctx, projectID, bqDataset, bqTable, bqProcessesTable)
	if err != nil {
		log.Printf("⚠️ BigQuery client init failed; continuing without export: %v", err)
		bqExporter = nil
	}
	if bqExporter != nil {
		defer func() {
			if err := bqExporter.Close(); err != nil {
				log.Printf("BigQuery client close: %v", err)
			}
		}()
		log.Printf("📊 BigQuery export enabled: dataset=%q samples=%q processes=%q",
			bqDataset, bqSamplesTableOrDefault(bqTable), bqProcessesTableOrDefault(bqProcessesTable))
	} else {
		log.Printf("📊 BigQuery export disabled (set BIGQUERY_EXPORT_DATASET to enable)")
	}

	// Initialize storage client
	storageClient, err := storage.NewClient(ctx, projectID)
	if err != nil {
		log.Fatalf("Failed to initialize storage: %v", err)
	}
	defer storageClient.Close()

	exportSched := exportqueue.New(bqExporter, storageClient.GetRunWithContext, storageClient.GetProcessesWithContext)

	// Initialize handlers
	h := handlers.NewHandlers(storageClient, exportSched)

	// Initialize cleanup service
	cleanupService := cleanup.NewService(storageClient, exportSched)

	// Set up HTTP routes
	http.HandleFunc("/healthz", h.Health)
	http.HandleFunc("/auth/run/", h.Auth)
	http.HandleFunc("/ingest", h.Ingest)
	http.HandleFunc("/runs/", h.GetRun)
	http.HandleFunc("/finish/", h.FinishRun)
	http.HandleFunc("/cleanup/stale", cleanupService.HandleManualStaleCleanup)

	// Add a simple test endpoint
	http.HandleFunc("/test", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("Test endpoint working"))
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	log.Printf("🚀 Server starting on port %s", port)
	log.Printf("📊 Monitoring endpoints:")
	log.Printf("   - GET  /healthz")
	log.Printf("   - POST /auth/run/{runId}")
	log.Printf("   - POST /ingest (JWT required)")
	log.Printf("   - GET  /runs/{runId}")
	log.Printf("   - POST /finish/{runId} (JWT required)")
	log.Printf("   - POST /cleanup/stale (Admin required)")

	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatalf("Server failed to start: %v", err)
	}
}

func bqSamplesTableOrDefault(table string) string {
	if table == "" {
		return "build_process_samples"
	}
	return table
}

func bqProcessesTableOrDefault(table string) string {
	if table == "" {
		return "build_process_processes"
	}
	return table
}
