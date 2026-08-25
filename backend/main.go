package main

import (
	"context"
	"log"

	"github.com/cdsap/build-process-watcher/backend/internal/scoring"
	"github.com/cdsap/build-process-watcher/backend/pkg/server"
)

func main() {
	options := server.OptionsFromEnv()
	// Wire scoring sentinel classification at the composition root so the HTTP
	// adapter stays free of concrete provider/scoring error imports.
	options.FallbackClassifier = predictionFallbackClassifier
	if err := server.Run(context.Background(), options); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}

func predictionFallbackClassifier(err error) (state string, message string) {
	fallbackState, fallbackMessage := scoring.ClassifyFallback(err)
	return string(fallbackState), fallbackMessage
}
