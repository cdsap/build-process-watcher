package main

import (
	"context"
	"log"
	"net/http"
	"os"

	"github.com/cdsap/build-process-watcher/backend/internal/auth"
	"github.com/cdsap/build-process-watcher/backend/internal/cleanup"
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

	// Initialize storage client
	storageClient, err := storage.NewClient(ctx, projectID)
	if err != nil {
		log.Fatalf("Failed to initialize storage: %v", err)
	}
	defer storageClient.Close()

	// Initialize handlers
	h := handlers.NewHandlers(storageClient)

	// Initialize cleanup service
	cleanupService := cleanup.NewService(storageClient)

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
