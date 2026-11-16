package storage

import (
	"time"

	"cloud.google.com/go/firestore"
	"github.com/cdsap/build-process-watcher/backend/internal/models"
)

// SampleAppendHint carries the ingest GetRun snapshot so StoreSamples can append
// without decoding the full samples array a second time.
type SampleAppendHint struct {
	// StartTime is the run clock already chosen for ParseData.
	StartTime time.Time
	// Prior is the GetRun document, or nil when the run did not exist yet.
	Prior *models.RunDoc
	// AvoidFullReload skips the transactional full-document read when the
	// caller already holds Prior/StartTime from ingest. Sample appends use
	// ArrayUnion so concurrent ingests do not clobber each other; prediction
	// and finish fields remain untouched via MergeAll key isolation.
	AvoidFullReload bool
}

// reservedRunWriteKeys must never appear in sample/checkpoint/forecast merge maps,
// so concurrent writers cannot clobber sibling fields via a full document Set.
var reservedRunWriteKeys = map[string]struct{}{
	"prediction_checkpoints": {},
	"process_forecasts":      {},
	"finished":               {},
	"finished_at":            {},
	"expire_at":              {},
	"export_to_bigquery":     {},
	"predictive_reliability": {},
	"prediction_mode":        {},
}

// sampleStoreFields builds a MergeAll payload that only updates samples and
// identity/timestamp metadata. Prediction and finish fields are intentionally
// omitted so a concurrent checkpoint/forecast write cannot be wiped.
func sampleStoreFields(runID string, existing *models.RunDoc, incoming []models.Sample, now time.Time) map[string]interface{} {
	return sampleStoreFieldsWithStart(runID, existing, incoming, now, time.Time{})
}

func sampleStoreFieldsWithStart(runID string, existing *models.RunDoc, incoming []models.Sample, now, knownStart time.Time) map[string]interface{} {
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
		start := knownStart
		if start.IsZero() {
			start = now
		}
		fields["start_time"] = start
	}
	if existing == nil || existing.CreatedAt.IsZero() {
		fields["created_at"] = now
	}
	return fields
}

// sampleAppendFields builds a MergeAll payload that appends via ArrayUnion so
// StoreSamples does not need to decode the existing samples array.
func sampleAppendFields(runID string, incoming []models.Sample, now time.Time, hint SampleAppendHint) map[string]interface{} {
	if hasFreshness(incoming) && len(incoming) > 0 {
		stampFreshnessStored(incoming, now)
	}
	elems := make([]interface{}, len(incoming))
	for i := range incoming {
		elems[i] = incoming[i]
	}
	fields := map[string]interface{}{
		"id":                   runID,
		"run_id":               runID,
		"samples":              firestore.ArrayUnion(elems...),
		"updated_at":           now,
		"updated_at_timestamp": ToMillis(now),
	}
	prior := hint.Prior
	if prior == nil || prior.StartTime.IsZero() {
		start := hint.StartTime
		if start.IsZero() {
			start = now
		}
		fields["start_time"] = start
	}
	if prior == nil || prior.CreatedAt.IsZero() {
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
