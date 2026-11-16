package main

import (
	"context"
	"log"

	"github.com/cdsap/build-process-watcher/backend/pkg/server"
)

func main() {
	if err := server.Run(context.Background(), server.OptionsFromEnv()); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}
