package main

import (
	"context"
	"log"

	"github.com/cdsap/build-process-watcher-predictive-provider/internal/provider"
	"github.com/cdsap/build-process-watcher/backend/pkg/server"
)

func main() {
	options := server.OptionsFromEnv()
	options.PredictionProvider = provider.New(provider.ConfigFromEnv())
	if err := server.Run(context.Background(), options); err != nil {
		log.Fatalf("Predictive backend failed: %v", err)
	}
}
