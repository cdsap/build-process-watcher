package models

import "strings"

// PredictionMode is the public prediction_mode query/document value.
type PredictionMode string

const (
	PredictionModeDisabled    PredictionMode = "disabled"
	PredictionModeReliability PredictionMode = "reliability"
	PredictionModeForecast    PredictionMode = "forecast"
	PredictionModePredict     PredictionMode = "predict"
	PredictionModeBQMLBoosted PredictionMode = "bqml-boosted"
)

// ThrottleElapsedSeconds is the shared process-forecast / Cloud Tasks dedupe
// bucket size for all timeline modes (forecast / predict / bqml-boosted).
const ThrottleElapsedSeconds = 20

// ParsePredictionMode accepts a public mode string (including empty / unset).
func ParsePredictionMode(raw string) (PredictionMode, bool) {
	mode := PredictionMode(strings.TrimSpace(raw))
	switch mode {
	case "", PredictionModeDisabled, PredictionModeReliability, PredictionModeForecast, PredictionModePredict, PredictionModeBQMLBoosted:
		return mode, true
	default:
		return "", false
	}
}

// String returns the wire/document form.
func (m PredictionMode) String() string {
	return string(m)
}

// IsTimeline reports whether the mode uses a process-forecast provider.
func (m PredictionMode) IsTimeline() bool {
	switch m {
	case PredictionModeForecast, PredictionModePredict, PredictionModeBQMLBoosted:
		return true
	default:
		return false
	}
}
