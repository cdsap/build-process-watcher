package provider

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"math"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/cdsap/build-process-watcher-predictive-provider/internal/features"
	"github.com/cdsap/build-process-watcher-predictive-provider/internal/telemetry"
	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
)

const (
	defaultProviderID    = "private-provider"
	defaultModelVersion  = "private-heuristic-v1"
	defaultScoreTimeout  = 2 * time.Second
	publicReadyMessage   = "private predictive provider evaluated runtime telemetry"
	publicLimitedMessage = "private predictive provider evaluated limited telemetry"
	publicSkippedMessage = "checkpoint already evaluated"
)

// Config holds private provider configuration.
type Config struct {
	ProviderID     string
	ModelVersion   string
	ScoreTimeout   time.Duration
	Telemetry      *telemetry.Store
	PromotedModels map[int]string
}

// ConfigFromEnv reads private provider metadata from environment variables.
func ConfigFromEnv() Config {
	return Config{
		ProviderID:     strings.TrimSpace(os.Getenv("PREDICTIVE_PROVIDER_ID")),
		ModelVersion:   strings.TrimSpace(os.Getenv("PREDICTIVE_MODEL_VERSION")),
		ScoreTimeout:   scoreTimeoutFromEnv(),
		PromotedModels: parsePromotedModels(os.Getenv("PREDICTIVE_PROMOTED_MODELS")),
	}
}

func scoreTimeoutFromEnv() time.Duration {
	raw := strings.TrimSpace(os.Getenv("PREDICTIVE_SCORING_TIMEOUT_MS"))
	if raw == "" {
		return 0
	}
	ms, err := strconv.Atoi(raw)
	if err != nil || ms <= 0 {
		return 0
	}
	return time.Duration(ms) * time.Millisecond
}

// Provider implements the public Build Process Watcher prediction contract.
type Provider struct {
	providerID     string
	modelVersion   string
	scoreTimeout   time.Duration
	telemetry      *telemetry.Store
	promotedModels map[int]string
	// scoreHook is an optional private live-scoring seam used by tests and future BigQuery ML clients.
	scoreHook func(context.Context, features.CheckpointRow, int) (scoredValues, error)
}

type scoredValues struct {
	riskLevel          string
	riskScore          *float64
	confidence         string
	predictedPeakRSSMB *float64
	predictedDurationS *float64
	signals            []string
	message            string
	modelVersion       string
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
	scoreTimeout := config.ScoreTimeout
	if scoreTimeout <= 0 {
		scoreTimeout = defaultScoreTimeout
	}
	store := config.Telemetry
	if store == nil {
		store = telemetry.NewStore()
	}
	promotedModels := config.PromotedModels
	if promotedModels == nil {
		promotedModels = map[int]string{}
	}
	return &Provider{
		providerID:     providerID,
		modelVersion:   modelVersion,
		scoreTimeout:   scoreTimeout,
		telemetry:      store,
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

// Telemetry returns the private scoring telemetry store for ops review.
func (p *Provider) Telemetry() *telemetry.Store {
	return p.telemetry
}

// Predict returns a public-safe checkpoint from private scoring signals.
func (p *Provider) Predict(ctx context.Context, snapshot predictor.RunSnapshot, observationWindowS int) (predictor.PredictionCheckpoint, error) {
	now := snapshot.Now
	if now.IsZero() {
		now = time.Now()
	}
	started := time.Now()
	modelVersion := p.modelVersionForWindow(observationWindowS)

	for _, checkpoint := range snapshot.ExistingCheckpoints {
		if checkpoint.ObservationWindowS == observationWindowS {
			p.record(telemetry.Event{
				ObservationWindowS: observationWindowS,
				ModelVersion:       modelVersion,
				Outcome:            telemetry.OutcomeSkipped,
				Latency:            time.Since(started),
				Diagnostic:         "checkpoint window already evaluated; scoring skipped",
				RunID:              snapshot.RunID,
			})
			return predictor.PredictionCheckpoint{
				ObservationWindowS: observationWindowS,
				Status:             "skipped",
				ProviderID:         p.providerID,
				CreatedAt:          now,
				Message:            publicSkippedMessage,
			}, nil
		}
	}

	if len(snapshot.Samples) == 0 {
		p.record(telemetry.Event{
			ObservationWindowS: observationWindowS,
			ModelVersion:       modelVersion,
			Outcome:            telemetry.OutcomeError,
			Latency:            time.Since(started),
			Diagnostic:         "snapshot has no samples",
			RunID:              snapshot.RunID,
		})
		return predictor.PredictionCheckpoint{}, errors.New("snapshot has no samples")
	}

	scoreCtx := ctx
	cancel := func() {}
	if p.scoreTimeout > 0 {
		scoreCtx, cancel = context.WithTimeout(ctx, p.scoreTimeout)
	}
	defer cancel()

	row := features.FromSnapshot(snapshot, observationWindowS)
	scored, err := p.score(scoreCtx, row, observationWindowS)
	latency := time.Since(started)
	if err != nil {
		outcome := telemetry.OutcomeError
		diagnostic := err.Error()
		if errors.Is(err, context.DeadlineExceeded) {
			outcome = telemetry.OutcomeTimeout
			diagnostic = "live scoring timed out: " + err.Error()
		}
		p.record(telemetry.Event{
			ObservationWindowS: observationWindowS,
			ModelVersion:       modelVersion,
			Outcome:            outcome,
			Latency:            latency,
			Diagnostic:         diagnostic,
			RunID:              snapshot.RunID,
		})
		// Keep returned errors generic so HTTP/API fallback messages stay public-safe.
		if outcome == telemetry.OutcomeTimeout {
			return predictor.PredictionCheckpoint{}, errors.New("scoring timed out")
		}
		return predictor.PredictionCheckpoint{}, errors.New("scoring failed")
	}

	scoredModelVersion := scored.modelVersion
	if scoredModelVersion == "" {
		scoredModelVersion = modelVersion
	}
	p.record(telemetry.Event{
		ObservationWindowS: observationWindowS,
		ModelVersion:       scoredModelVersion,
		Outcome:            telemetry.OutcomeSuccess,
		Latency:            latency,
		Diagnostic:         "live scoring produced public-safe checkpoint",
		RunID:              snapshot.RunID,
	})

	return predictor.PredictionCheckpoint{
		ObservationWindowS: observationWindowS,
		Status:             "ready",
		RiskLevel:          scored.riskLevel,
		RiskScore:          scored.riskScore,
		Confidence:         scored.confidence,
		PredictedPeakRSSMB: scored.predictedPeakRSSMB,
		PredictedDurationS: scored.predictedDurationS,
		Signals:            scored.signals,
		ProviderID:         p.providerID,
		ModelVersion:       scoredModelVersion,
		CreatedAt:          now,
		Message:            scored.message,
	}, nil
}

func (p *Provider) score(ctx context.Context, row features.CheckpointRow, observationWindowS int) (scoredValues, error) {
	if err := ctx.Err(); err != nil {
		return scoredValues{}, err
	}
	if p.scoreHook != nil {
		return p.scoreHook(ctx, row, observationWindowS)
	}
	return p.scoreHeuristic(row, observationWindowS), nil
}

func (p *Provider) scoreHeuristic(row features.CheckpointRow, observationWindowS int) scoredValues {
	modelVersion := p.modelVersionForWindow(observationWindowS)
	if row.PeakRSSMB == 0 {
		return scoredValues{
			riskLevel:    "unknown",
			confidence:   "low",
			signals:      []string{"insufficient memory signal"},
			message:      publicLimitedMessage,
			modelVersion: modelVersion,
		}
	}

	score, signals := scoreFeatures(row)
	risk := riskLevel(score)
	confidence := confidenceLevel(row, observationWindowS)
	predictedRSS := roundOneDecimal(row.PeakRSSMB + math.Max(row.RSSGrowthMBPerMin, 0)*0.75)
	predictedDuration := roundOneDecimal(row.MaxElapsedS * (1.04 + score*0.18))
	score = roundOneDecimal(score)
	return scoredValues{
		riskLevel:          risk,
		riskScore:          &score,
		confidence:         confidence,
		predictedPeakRSSMB: &predictedRSS,
		predictedDurationS: &predictedDuration,
		signals:            signals,
		message:            publicReadyMessage,
		modelVersion:       modelVersion,
	}
}

func (p *Provider) record(event telemetry.Event) {
	p.telemetry.Record(event)
	log.Printf(
		"scoring_telemetry outcome=%s window=%ds model=%q latency_ms=%d run=%q diagnostic=%q",
		event.Outcome,
		event.ObservationWindowS,
		event.ModelVersion,
		event.Latency.Milliseconds(),
		event.RunID,
		event.Diagnostic,
	)
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
