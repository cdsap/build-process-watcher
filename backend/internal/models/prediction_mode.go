package models

import "strings"

// ProcessForecastThrottleElapsedS is the shared cadence for timeline modes
// (forecast / predict / bqml-boosted) across evaluators and Cloud Tasks dedupe.
const ProcessForecastThrottleElapsedS = 20

// PredictionMode is the public run prediction setting.
type PredictionMode string

const (
	PredictionModeUnset       PredictionMode = ""
	PredictionModeDisabled    PredictionMode = "disabled"
	PredictionModeForecast    PredictionMode = "forecast"
	PredictionModePredict     PredictionMode = "predict"
	PredictionModeBQMLBoosted PredictionMode = "bqml-boosted"
)

// ParsePredictionMode validates a query/env prediction_mode value.
func ParsePredictionMode(raw string) (PredictionMode, bool) {
	mode := PredictionMode(strings.TrimSpace(raw))
	switch mode {
	case PredictionModeUnset, PredictionModeDisabled,
		PredictionModeForecast, PredictionModePredict, PredictionModeBQMLBoosted:
		return mode, true
	default:
		return "", false
	}
}

// NormalizePredictionMode returns a canonical mode for evaluation (unknown → unset).
func NormalizePredictionMode(raw string) PredictionMode {
	mode, ok := ParsePredictionMode(raw)
	if !ok {
		return PredictionModeUnset
	}
	return mode
}

// IsTimeline reports whether the mode writes process_forecasts issuances.
func (m PredictionMode) IsTimeline() bool {
	switch m {
	case PredictionModeForecast, PredictionModePredict, PredictionModeBQMLBoosted:
		return true
	default:
		return false
	}
}

// String returns the wire form.
func (m PredictionMode) String() string {
	return string(m)
}

// ShouldEnqueuePrediction reports whether ingest should schedule a prediction job.
func ShouldEnqueuePrediction(mode PredictionMode, _ bool) bool {
	return mode.IsTimeline()
}
