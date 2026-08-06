package provider

import (
	"context"
	"errors"
	"math"
	"os"
	"strings"
	"time"

	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
)

const (
	defaultProviderID   = "private-provider"
	defaultModelVersion = "private-heuristic-v1"
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

// Predict returns a public-safe checkpoint from private scoring signals.
func (p *Provider) Predict(_ context.Context, snapshot predictor.RunSnapshot, observationWindowS int) (predictor.PredictionCheckpoint, error) {
	now := snapshot.Now
	if now.IsZero() {
		now = time.Now()
	}

	for _, checkpoint := range snapshot.ExistingCheckpoints {
		if checkpoint.ObservationWindowS == observationWindowS {
			return predictor.PredictionCheckpoint{
				ObservationWindowS: observationWindowS,
				Status:             "skipped",
				ProviderID:         p.providerID,
				CreatedAt:          now,
				Message:            "checkpoint already evaluated",
			}, nil
		}
	}

	if len(snapshot.Samples) == 0 {
		return predictor.PredictionCheckpoint{}, errors.New("snapshot has no samples")
	}

	features := extractFeatures(snapshot)
	if features.peakRSSMB == 0 {
		return predictor.PredictionCheckpoint{
			ObservationWindowS: observationWindowS,
			Status:             "ready",
			RiskLevel:          "unknown",
			Confidence:         "low",
			Signals:            []string{"insufficient memory signal"},
			ProviderID:         p.providerID,
			ModelVersion:       p.modelVersion,
			CreatedAt:          now,
			Message:            "private predictive provider evaluated limited telemetry",
		}, nil
	}

	score, signals := scoreFeatures(features)
	riskLevel := riskLevel(score)
	confidence := confidenceLevel(features, observationWindowS)
	predictedRSS := roundOneDecimal(features.peakRSSMB + math.Max(features.rssGrowthMBPerMin, 0)*0.75)
	predictedDuration := roundOneDecimal(features.maxElapsedS * (1.04 + score*0.18))
	score = roundOneDecimal(score)

	return predictor.PredictionCheckpoint{
		ObservationWindowS: observationWindowS,
		Status:             "ready",
		RiskLevel:          riskLevel,
		RiskScore:          &score,
		Confidence:         confidence,
		PredictedPeakRSSMB: &predictedRSS,
		PredictedDurationS: &predictedDuration,
		Signals:            signals,
		ProviderID:         p.providerID,
		ModelVersion:       p.modelVersion,
		CreatedAt:          now,
		Message:            "private predictive provider evaluated runtime telemetry",
	}, nil
}

type runtimeFeatures struct {
	sampleCount       int
	processCount      int
	maxElapsedS       float64
	firstElapsedS     float64
	peakRSSMB         float64
	firstRSSMB        float64
	latestRSSMB       float64
	rssGrowthMBPerMin float64
	heapUtilization   float64
	gcTimeRatio       float64
}

func extractFeatures(snapshot predictor.RunSnapshot) runtimeFeatures {
	features := runtimeFeatures{
		sampleCount:  len(snapshot.Samples),
		processCount: len(snapshot.ProcessInfo),
	}

	var firstRSSSet bool
	maxGCTimeMs := 0
	for _, sample := range snapshot.Samples {
		elapsed := float64(sample.ElapsedTime)
		rssMB := float64(sample.RSS)
		if sample.RSS > 0 && (!firstRSSSet || elapsed < features.firstElapsedS) {
			features.firstElapsedS = elapsed
			features.firstRSSMB = rssMB
			firstRSSSet = true
		}
		if elapsed >= features.maxElapsedS {
			features.maxElapsedS = elapsed
			if sample.RSS > 0 {
				features.latestRSSMB = rssMB
			}
		}
		if rssMB > features.peakRSSMB {
			features.peakRSSMB = rssMB
		}
		if sample.HeapCap > 0 && sample.HeapUsed > 0 {
			features.heapUtilization = math.Max(features.heapUtilization, float64(sample.HeapUsed)/float64(sample.HeapCap))
		}
		if sample.GCTime > maxGCTimeMs {
			maxGCTimeMs = sample.GCTime
		}
	}

	elapsedDelta := features.maxElapsedS - features.firstElapsedS
	if elapsedDelta > 0 && firstRSSSet && features.latestRSSMB > 0 {
		features.rssGrowthMBPerMin = (features.latestRSSMB - features.firstRSSMB) / elapsedDelta * 60.0
	}
	if features.maxElapsedS > 0 && maxGCTimeMs > 0 {
		features.gcTimeRatio = float64(maxGCTimeMs) / (features.maxElapsedS * 1000.0)
	}
	return features
}

func scoreFeatures(features runtimeFeatures) (float64, []string) {
	score := 0.0
	signals := make([]string, 0, 4)

	if features.peakRSSMB >= 3072 {
		score += 0.35
		signals = append(signals, "high memory pressure")
	} else if features.peakRSSMB >= 1536 {
		score += 0.22
		signals = append(signals, "memory pressure")
	}

	if features.rssGrowthMBPerMin >= 512 {
		score += 0.30
		signals = append(signals, "rapid memory growth")
	} else if features.rssGrowthMBPerMin >= 128 {
		score += 0.14
		signals = append(signals, "memory growth")
	}

	if features.heapUtilization >= 0.85 {
		score += 0.20
		signals = append(signals, "heap saturation")
	} else if features.heapUtilization >= 0.70 {
		score += 0.10
		signals = append(signals, "heap pressure")
	}

	if features.gcTimeRatio >= 0.15 {
		score += 0.18
		signals = append(signals, "gc pressure")
	} else if features.gcTimeRatio >= 0.07 {
		score += 0.09
		signals = append(signals, "gc activity")
	}

	if features.processCount >= 5 {
		score += 0.08
		signals = append(signals, "process fanout")
	}

	if len(signals) == 0 {
		signals = append(signals, "stable runtime profile")
	}
	if len(signals) > 3 {
		signals = signals[:3]
	}
	return math.Min(score, 1.0), signals
}

func riskLevel(score float64) string {
	switch {
	case score >= 0.65:
		return "high"
	case score >= 0.30:
		return "elevated"
	default:
		return "low"
	}
}

func confidenceLevel(features runtimeFeatures, observationWindowS int) string {
	if features.sampleCount >= 4 && features.maxElapsedS >= float64(observationWindowS) {
		return "high"
	}
	if features.sampleCount >= 2 {
		return "medium"
	}
	return "low"
}

func roundOneDecimal(value float64) float64 {
	return float64(int(value*10+0.5)) / 10
}

var _ predictor.Provider = (*Provider)(nil)
