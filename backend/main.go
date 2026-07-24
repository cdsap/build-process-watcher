package main

import (
	"context"
	"log"

	"github.com/cdsap/build-process-watcher/backend/pkg/server"
)

func main() {
	options := server.OptionsFromEnv()
	if err := server.Run(context.Background(), options); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}
