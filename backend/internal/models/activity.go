package models

import "sort"

// ProcessActivityForecast is a count-based issuance; it never uses memory units.
// Status is ready, insufficient_history, unavailable, or fallback. Non-ready
// results may omit origin and points; no numeric guess is fabricated.
type ProcessActivityForecast struct {
	ProcessName        string                  `json:"process_name" firestore:"process_name"`
	PID                string                  `json:"pid" firestore:"pid"`
	Metric             string                  `json:"metric" firestore:"metric"`
	CreatedAtMs        int64                   `json:"created_at_ms" firestore:"created_at_ms"`
	OriginValueCount   *float64                `json:"origin_value_count,omitempty" firestore:"origin_value_count,omitempty"`
	Points             []ActivityForecastPoint `json:"points,omitempty" firestore:"points,omitempty"`
	Status             string                  `json:"status" firestore:"status"`
	Method             string                  `json:"method,omitempty" firestore:"method,omitempty"`
	ModelVersion       string                  `json:"model_version,omitempty" firestore:"model_version,omitempty"`
	LatencyMs          int64                   `json:"latency_ms,omitempty" firestore:"latency_ms,omitempty"`
	ProviderLatencyMs  int64                   `json:"provider_latency_ms,omitempty" firestore:"provider_latency_ms,omitempty"`
	InferenceLatencyMs int64                   `json:"inference_latency_ms,omitempty" firestore:"inference_latency_ms,omitempty"`
	Fallback           bool                    `json:"fallback,omitempty" firestore:"fallback,omitempty"`
}
type ActivityForecastPoint struct {
	TargetAtMs          int64   `json:"target_at_ms" firestore:"target_at_ms"`
	PredictedDeltaCount float64 `json:"predicted_delta_count" firestore:"predicted_delta_count"`
	PredictedTotalCount float64 `json:"predicted_total_count" firestore:"predicted_total_count"`
}

// MergeActivityForecasts upserts by process, metric and original issuance time.
func MergeActivityForecasts(existing, additions []ProcessActivityForecast) []ProcessActivityForecast {
	type key struct {
		name, pid, metric string
		at                int64
	}
	values := map[key]ProcessActivityForecast{}
	for _, batch := range [][]ProcessActivityForecast{existing, additions} {
		for _, f := range batch {
			k := key{f.ProcessName, f.PID, f.Metric, f.CreatedAtMs}
			if prior, exists := values[k]; exists && (prior.Status == "ready" || prior.Status == "fallback") && f.Status != "ready" {
				continue
			}
			values[k] = f
		}
	}
	out := make([]ProcessActivityForecast, 0, len(values))
	for _, f := range values {
		out = append(out, f)
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.CreatedAtMs != b.CreatedAtMs {
			return a.CreatedAtMs < b.CreatedAtMs
		}
		if a.ProcessName != b.ProcessName {
			return a.ProcessName < b.ProcessName
		}
		return a.PID < b.PID
	})
	return out
}
func ParsePredictionTarget(raw string, mode PredictionMode) (string, bool) {
	if raw == "" {
		raw = "memory"
	}
	return raw, raw == "memory" || (raw == "class_loading" &&
		(mode == PredictionModePredict || mode == PredictionModeForecast || mode == PredictionModeTabPFN))
}
