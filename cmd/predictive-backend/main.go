package main

import (
	"log"
	"net/http"
	"os"

	"github.com/cdsap/build-process-watcher-predictive-provider/internal/api"
	"github.com/cdsap/build-process-watcher-predictive-provider/internal/provider"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	server := api.NewServer(provider.New(provider.ConfigFromEnv()))
	log.Printf("Private predictive provider starting on port %s", port)
	log.Printf("   - GET  /healthz")
	log.Printf("   - POST /predict")
	if err := http.ListenAndServe(":"+port, server.Handler()); err != nil {
		log.Fatalf("Predictive backend failed: %v", err)
	}
}
