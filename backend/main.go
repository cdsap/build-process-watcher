package main

import (
	"context"
	"log"

	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
	"github.com/cdsap/build-process-watcher/backend/pkg/server"
)

func main() {
	options := server.OptionsFromEnv()
	options.PredictionProvider = predictor.NoopProvider{}
	if err := server.Run(context.Background(), options); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}
