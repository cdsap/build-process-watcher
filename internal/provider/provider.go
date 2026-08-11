package provider

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/cdsap/build-process-watcher-predictive-provider/internal/features"
	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
)

const (
	defaultProviderID   = "private-provider"
	defaultModelVersion = "private-heuristic-v1"
)

// Config holds private provider configuration.
type Config struct {
	ProviderID     string
	ModelVersion   string
	PromotedModels map[int]string
}

// ConfigFromEnv reads private provider metadata from environment variables.
func ConfigFromEnv() Config {
	return Config{
		ProviderID:     strings.TrimSpace(os.Getenv("PREDICTIVE_PROVIDER_ID")),
		ModelVersion:   strings.TrimSpace(os.Getenv("PREDICTIVE_MODEL_VERSION")),
		PromotedModels: parsePromotedModels(os.Getenv("PREDICTIVE_PROMOTED_MODELS")),
	}
}

// Provider implements the public Build Process Watcher prediction contract.
type Provider struct {
	providerID     string
	modelVersion   string
	promotedModels map[int]string
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
	promotedModels := config.PromotedModels
	if promotedModels == nil {
		promotedModels = map[int]string{}
	}
	return &Provider{
		providerID:     providerID,
		modelVersion:   modelVersion,
		promotedModels: promotedModels,
	}
}

func (p *Provider) modelVersionForWindow(observationWindowS int) string {
	if version := strings.TrimSpace(p.promotedModels[observationWindowS]); version != "" {
		return version
	}
	return p.modelVersion
}

// parsePromotedModels accepts JSON object/array registry shapes or comma-separated
// window:version pairs produced by private model refresh promotion metadata.
func parsePromotedModels(raw string) map[int]string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return map[int]string{}
	}

	versions := map[int]string{}
	if strings.HasPrefix(raw, "{") {
		var object map[string]string
		if err := json.Unmarshal([]byte(raw), &object); err == nil {
			for key, value := range object {
				window, err := strconv.Atoi(strings.TrimSpace(key))
				if err != nil || window <= 0 || strings.TrimSpace(value) == "" {
					continue
				}
				versions[window] = strings.TrimSpace(value)
			}
			return versions
		}
		var registry struct {
			Models []struct {
				ObservationWindowS int    `json:"observation_window_s"`
				ModelVersion       string `json:"model_version"`
			} `json:"models"`
		}
		if err := json.Unmarshal([]byte(raw), &registry); err == nil {
			for _, model := range registry.Models {
				if model.ObservationWindowS <= 0 || strings.TrimSpace(model.ModelVersion) == "" {
					continue
				}
				versions[model.ObservationWindowS] = strings.TrimSpace(model.ModelVersion)
			}
			return versions
		}
	}

	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		windowText, version, ok := strings.Cut(part, ":")
		if !ok {
			continue
		}
		window, err := strconv.Atoi(strings.TrimSpace(windowText))
		if err != nil || window <= 0 {
			continue
		}
		version = strings.TrimSpace(version)
		if version == "" {
			continue
		}
		versions[window] = version
	}
	return versions
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

	modelVersion := p.modelVersionForWindow(observationWindowS)
	row := features.FromSnapshot(snapshot, observationWindowS)
	if row.PeakRSSMB == 0 {
		return predictor.PredictionCheckpoint{
			ObservationWindowS: observationWindowS,
			Status:             "ready",
			RiskLevel:          "unknown",
			Confidence:         "low",
			Signals:            []string{"insufficient memory signal"},
			ProviderID:         p.providerID,
			ModelVersion:       modelVersion,
			CreatedAt:          now,
			Message:            "private predictive provider evaluated limited telemetry",
		}, nil
	}

	score, signals := scoreFeatures(row)
	riskLevel := riskLevel(score)
	confidence := confidenceLevel(row, observationWindowS)
	predictedRSS := roundOneDecimal(row.PeakRSSMB + math.Max(row.RSSGrowthMBPerMin, 0)*0.75)
	predictedDuration := roundOneDecimal(row.MaxElapsedS * (1.04 + score*0.18))
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
		ModelVersion:       modelVersion,
		CreatedAt:          now,
		Message:            "private predictive provider evaluated runtime telemetry",
	}, nil
}

func scoreFeatures(row features.CheckpointRow) (float64, []string) {
	score := 0.0
	signals := make([]string, 0, 4)

	if row.PeakRSSMB >= 3072 {
		score += 0.35
		signals = append(signals, "high memory pressure")
	} else if row.PeakRSSMB >= 1536 {
		score += 0.22
		signals = append(signals, "memory pressure")
	}

	if row.RSSGrowthMBPerMin >= 512 {
		score += 0.30
		signals = append(signals, "rapid memory growth")
	} else if row.RSSGrowthMBPerMin >= 128 {
		score += 0.14
		signals = append(signals, "memory growth")
	}

	if row.HeapUtilization >= 0.85 {
		score += 0.20
		signals = append(signals, "heap saturation")
	} else if row.HeapUtilization >= 0.70 {
		score += 0.10
		signals = append(signals, "heap pressure")
	}

	if row.GCTimeRatio >= 0.15 {
		score += 0.18
		signals = append(signals, "gc pressure")
	} else if row.GCTimeRatio >= 0.07 {
		score += 0.09
		signals = append(signals, "gc activity")
	}

	if row.ProcessCount >= 5 {
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

func confidenceLevel(row features.CheckpointRow, observationWindowS int) string {
	if row.SampleCount >= 4 && row.MaxElapsedS >= float64(observationWindowS) {
		return "high"
	}
	if row.SampleCount >= 2 {
		return "medium"
	}
	return "low"
}

func roundOneDecimal(value float64) float64 {
	return float64(int(value*10+0.5)) / 10
}

var _ predictor.Provider = (*Provider)(nil)
