package models

import (
	"strconv"
	"strings"
)

// ProcessForecastThrottleElapsedS is the default cadence for timeline modes
// (forecast / predict / bqml-boosted) across evaluators and Cloud Tasks dedupe.
// Per-run overrides use prediction_throttle_s.
const ProcessForecastThrottleElapsedS = 20

// ProcessForecastThrottleElapsedSMax is the largest accepted prediction_throttle_s.
const ProcessForecastThrottleElapsedSMax = 3600

// PredictionMode is the public run prediction setting.
type PredictionMode string

const (
	PredictionModeUnset       PredictionMode = ""
	PredictionModeDisabled    PredictionMode = "disabled"
	PredictionModeForecast    PredictionMode = "forecast"
	PredictionModePredict     PredictionMode = "predict"
	PredictionModeBQMLBoosted PredictionMode = "bqml-boosted"
)

// ParseThrottleElapsedS validates a prediction_throttle_s query/input value.
// Empty means unset (use the default). Values must be integers in [1, Max].
func ParseThrottleElapsedS(raw string) (int, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, true
	}
	seconds, err := strconv.Atoi(raw)
	if err != nil || seconds < 1 || seconds > ProcessForecastThrottleElapsedSMax {
		return 0, false
	}
	return seconds, true
}

// NormalizeThrottleElapsedS returns a positive throttle, falling back to the default.
func NormalizeThrottleElapsedS(seconds int) int {
	if seconds <= 0 {
		return ProcessForecastThrottleElapsedS
	}
	if seconds > ProcessForecastThrottleElapsedSMax {
		return ProcessForecastThrottleElapsedSMax
	}
	return seconds
}

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
