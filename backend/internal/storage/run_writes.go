package storage

import (
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/models"
)

// reservedRunWriteKeys must never appear in sample/checkpoint/forecast merge maps,
// so concurrent writers cannot clobber sibling fields via a full document Set.
var reservedRunWriteKeys = map[string]struct{}{
	"prediction_checkpoints":     {},
	"process_forecasts":          {},
	"process_activity_forecasts": {},
	"prediction_target":          {},
	"finished":                   {},
	"finished_at":                {},
	"expire_at":                  {},
	"export_to_bigquery":         {},
	"predictive_reliability":     {},
	"prediction_mode":            {},
	"prediction_throttle_s":      {},
}

// sampleStoreFields builds a MergeAll payload that only updates samples and
// identity/timestamp metadata. Prediction and finish fields are intentionally
// omitted so a concurrent checkpoint/forecast write cannot be wiped.
func sampleStoreFields(runID string, existing *models.RunDoc, incoming []models.Sample, now time.Time) map[string]interface{} {
	base := []models.Sample(nil)
	if existing != nil {
		base = existing.Samples
	}
	merged := make([]models.Sample, 0, len(base)+len(incoming))
	merged = append(merged, base...)
	merged = append(merged, incoming...)

	if hasFreshness(incoming) && len(incoming) > 0 {
		stampFreshnessStored(merged[len(merged)-len(incoming):], now)
	}

	fields := map[string]interface{}{
		"id":                   runID,
		"run_id":               runID,
		"samples":              merged,
		"updated_at":           now,
		"updated_at_timestamp": ToMillis(now),
	}
	if existing == nil || existing.StartTime.IsZero() {
		fields["start_time"] = now
	}
	if existing == nil || existing.CreatedAt.IsZero() {
		fields["created_at"] = now
	}
	return fields
}

// checkpointStoreFields builds a MergeAll payload for one checkpoint upsert.
func checkpointStoreFields(runID string, existing []models.PredictionCheckpoint, checkpoint models.PredictionCheckpoint, now time.Time) map[string]interface{} {
	return map[string]interface{}{
		"run_id":                 runID,
		"prediction_checkpoints": models.MergePredictionCheckpoint(existing, checkpoint),
		"updated_at":             now,
		"updated_at_timestamp":   ToMillis(now),
	}
}

// forecastStoreFields builds a MergeAll payload that appends process forecasts.
func forecastStoreFields(runID string, existing []models.ProcessForecast, additions []models.ProcessForecast, now time.Time) map[string]interface{} {
	return map[string]interface{}{
		"run_id":               runID,
		"process_forecasts":    models.AppendProcessForecasts(existing, additions),
		"updated_at":           now,
		"updated_at_timestamp": ToMillis(now),
	}
}

// processInfoStoreFields builds a MergeAll payload for one PID in processes/{runID}.
// Nested process_info is rewritten from the transactional snapshot so concurrent
// PID writers cannot drop each other.
func processInfoStoreFields(runID string, existing *models.ProcessDoc, info models.ProcessInfo, now time.Time) map[string]interface{} {
	processInfo := map[string]models.ProcessInfo{}
	if existing != nil && existing.ProcessInfo != nil {
		for pid, value := range existing.ProcessInfo {
			processInfo[pid] = value
		}
	}
	processInfo[info.PID] = info

	fields := map[string]interface{}{
		"run_id":               runID,
		"process_info":         processInfo,
		"updated_at":           now,
		"updated_at_timestamp": ToMillis(now),
	}
	if existing == nil || existing.CreatedAt.IsZero() {
		fields["created_at"] = now
	}
	return fields
}

// finishStoreFields builds a MergeAll payload that marks a run finished without
// rewriting samples or prediction arrays.
func finishStoreFields(runID string, existing *models.RunDoc, now time.Time) map[string]interface{} {
	fields := map[string]interface{}{
		"id":                   runID,
		"run_id":               runID,
		"finished":             true,
		"finished_at":          now,
		"updated_at":           now,
		"updated_at_timestamp": ToMillis(now),
		"expire_at":            now.Add(24 * time.Hour),
	}
	if existing == nil || existing.StartTime.IsZero() {
		fields["start_time"] = now
	}
	if existing == nil || existing.CreatedAt.IsZero() {
		fields["created_at"] = now
	}
	if existing == nil || existing.Samples == nil {
		fields["samples"] = []models.Sample{}
	}
	return fields
}

func containsReservedRunWriteKey(fields map[string]interface{}) string {
	for key := range fields {
		if _, reserved := reservedRunWriteKeys[key]; reserved {
			return key
		}
	}
	return ""
}

func activityForecastStoreFields(runID string, existing, additions []models.ProcessActivityForecast, now time.Time) map[string]interface{} {
	return map[string]interface{}{
		"run_id":                     runID,
		"process_activity_forecasts": models.AppendProcessActivityForecasts(existing, additions),
		"updated_at":                 now, "updated_at_timestamp": ToMillis(now),
	}
}
