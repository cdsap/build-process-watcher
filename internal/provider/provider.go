package provider

import (
	"context"
	"errors"
	"os"
	"strings"
	"time"

	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
)

const (
	defaultProviderID   = "private-provider"
	defaultModelVersion = "bootstrap-v0"
)

// Config holds private provider configuration.
type Config struct {
	ProviderID   string
	ModelVersion string
}

// ConfigFromEnv reads private provider metadata from environment variables.
func ConfigFromEnv() Config {
	return Config{
		ProviderID:   strings.TrimSpace(os.Getenv("PREDICTIVE_PROVIDER_ID")),
		ModelVersion: strings.TrimSpace(os.Getenv("PREDICTIVE_MODEL_VERSION")),
	}
}

// Provider implements the public Build Process Watcher prediction contract.
type Provider struct {
	providerID   string
	modelVersion string
}

// New creates a private predictive reliability provider.
func New(config Config) *Provider {
	providerID := config.ProviderID
	if providerID == "" {
		providerID = defaultProviderID
	}
	modelVersion := config.ModelVersion
	if modelVersion == "" {
		modelVersion = defaultModelVersion
	}
	return &Provider{
		providerID:   providerID,
		modelVersion: modelVersion,
	}
}

// Predict returns a public-safe bootstrap checkpoint.
func (p *Provider) Predict(_ context.Context, snapshot predictor.RunSnapshot, observationWindowS int) (predictor.PredictionCheckpoint, error) {
	if len(snapshot.Samples) == 0 {
		return predictor.PredictionCheckpoint{}, errors.New("snapshot has no samples")
	}

	now := snapshot.Now
	if now.IsZero() {
		now = time.Now()
	}

	maxRSSMB := 0.0
	maxElapsedS := 0.0
	for _, sample := range snapshot.Samples {
		if sample.RSS > 0 {
			rssMB := float64(sample.RSS) / 1024.0
			if rssMB > maxRSSMB {
				maxRSSMB = rssMB
			}
		}
		if float64(sample.ElapsedTime) > maxElapsedS {
			maxElapsedS = float64(sample.ElapsedTime)
		}
	}

	riskLevel := "low"
	confidence := "low"
	signals := []string{"bootstrap synthetic evaluator"}
	if maxRSSMB == 0 {
		riskLevel = "unknown"
		signals = []string{"insufficient memory signal"}
	} else if maxRSSMB >= 2048 {
		riskLevel = "elevated"
		confidence = "medium"
		signals = []string{"memory pressure"}
	}

	predictedRSS := roundOneDecimal(maxRSSMB * 1.08)
	predictedDuration := roundOneDecimal(maxElapsedS * 1.12)

	return predictor.PredictionCheckpoint{
		ObservationWindowS: observationWindowS,
		Status:             "ready",
		RiskLevel:          riskLevel,
		Confidence:         confidence,
		PredictedPeakRSSMB: &predictedRSS,
		PredictedDurationS: &predictedDuration,
		Signals:            signals,
		ProviderID:         p.providerID,
		ModelVersion:       p.modelVersion,
		CreatedAt:          now,
		Message:            "private predictive provider bootstrap",
	}, nil
}

func roundOneDecimal(value float64) float64 {
	return float64(int(value*10+0.5)) / 10
}

var _ predictor.Provider = (*Provider)(nil)
