package main

import (
	"context"
	"errors"
	"log"

	"github.com/cdsap/build-process-watcher/backend/internal/scoring"
	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
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
	// Map predictor-local remote transport kinds onto the shared scoring
	// taxonomy, then reuse ClassifyFallback for public-safe state/message pairs.
	switch {
	case errors.Is(err, predictor.ErrRemoteNoData):
		err = scoring.ErrNoData
	case errors.Is(err, predictor.ErrRemoteTimeout):
		err = scoring.ErrScoringTimeout
	case errors.Is(err, predictor.ErrRemoteUnavailable):
		err = scoring.ErrModelUnavailable
	case errors.Is(err, predictor.ErrRemoteFailed):
		err = scoring.ErrScoringFailed
	}
	fallbackState, fallbackMessage := scoring.ClassifyFallback(err)
	return string(fallbackState), fallbackMessage
}
