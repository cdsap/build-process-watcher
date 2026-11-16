package storage

import (
	"context"
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"

	"cloud.google.com/go/firestore"
	"github.com/cdsap/build-process-watcher/backend/internal/models"
	"google.golang.org/api/iterator"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Client wraps Firestore operations. Callers pass a request or job context on
// every method so cancellation and deadlines (e.g. prediction-job timeout) apply.
type Client struct {
	firestore *firestore.Client
}

// NewClient creates a new storage client. ctx is used only for Firestore dial.
func NewClient(ctx context.Context, projectID string) (*Client, error) {
	client, err := firestore.NewClient(ctx, projectID)
	if err != nil {
		return nil, fmt.Errorf("failed to create Firestore client: %w", err)
	}

	log.Printf("✅ Connected to Firestore project: %s", projectID)
	return &Client{firestore: client}, nil
}

// Close closes the Firestore client
func (c *Client) Close() error {
	return c.firestore.Close()
}

// SetRunExportToBigquery records that a run should be exported to BigQuery when it finishes.
func (c *Client) SetRunExportToBigquery(ctx context.Context, runID string, enabled bool) error {
	if !enabled {
		return nil
	}
	_, err := c.firestore.Collection("runs").Doc(runID).Set(ctx, map[string]interface{}{
		"run_id":               runID,
		"export_to_bigquery":   true,
		"updated_at":           time.Now(),
		"updated_at_timestamp": ToMillis(time.Now()),
	}, firestore.MergeAll)
	if err != nil {
		return fmt.Errorf("merge export_to_bigquery for run %s: %w", runID, err)
	}
	log.Printf("📊 Marked run %s for BigQuery export on finish", runID)
	return nil
}

// SetRunPredictiveReliability records that a run opted in to private predictive checkpoints.
func (c *Client) SetRunPredictiveReliability(ctx context.Context, runID string, enabled bool) error {
	if !enabled {
		return nil
	}
	now := time.Now()
	_, err := c.firestore.Collection("runs").Doc(runID).Set(ctx, map[string]interface{}{
		"run_id":                 runID,
		"predictive_reliability": true,
		"updated_at":             now,
		"updated_at_timestamp":   ToMillis(now),
	}, firestore.MergeAll)
	if err != nil {
		return fmt.Errorf("merge predictive_reliability for run %s: %w", runID, err)
	}
	log.Printf("🔮 Marked run %s for predictive reliability checkpoints", runID)
	return nil
}

// SetRunPredictionMode records the requested public prediction mode.
func (c *Client) SetRunPredictionMode(ctx context.Context, runID, mode string) error {
	now := time.Now()
	_, err := c.firestore.Collection("runs").Doc(runID).Set(ctx, map[string]interface{}{
		"run_id": runID, "prediction_mode": mode, "updated_at": now, "updated_at_timestamp": ToMillis(now),
	}, firestore.MergeAll)
	if err != nil {
		return fmt.Errorf("merge prediction mode for run %s: %w", runID, err)
	}
	return nil
}

// GetRun retrieves a run document by ID using ctx for cancellation/deadlines.
func (c *Client) GetRun(ctx context.Context, runID string) (*models.RunDoc, error) {
	doc := c.firestore.Collection("runs").Doc(runID)
	snapshot, err := doc.Get(ctx)
	if err != nil {
		if status.Code(err) == codes.NotFound {
			return nil, fmt.Errorf("%w: %s", ErrRunNotFound, runID)
		}
		return nil, err
	}

	if !snapshot.Exists() {
		return nil, fmt.Errorf("%w: %s", ErrRunNotFound, runID)
	}

	var runDoc models.RunDoc
	if err := snapshot.DataTo(&runDoc); err != nil {
		return nil, err
	}

	return &runDoc, nil
}

// StoreSamples appends samples for a run using a transaction + MergeAll so
// concurrent checkpoint/forecast/finish writers cannot be wiped by a full Set.
func (c *Client) StoreSamples(ctx context.Context, runID string, samples []models.Sample) error {
	log.Printf("🔄 Storing %d samples for run ID: %s", len(samples), runID)

	doc := c.firestore.Collection("runs").Doc(runID)
	err := c.firestore.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		existing, err := readRunDocInTx(tx, doc)
		if err != nil {
			return err
		}
		now := time.Now()
		fields := sampleStoreFields(runID, existing, samples, now)
		if existing != nil {
			log.Printf("📄 Found existing document with %d samples", len(existing.Samples))
		} else {
			log.Printf("📄 Creating new document for run ID: %s", runID)
		}
		if merged, ok := fields["samples"].([]models.Sample); ok {
			log.Printf("📊 Document now has %d samples total", len(merged))
		}
		return tx.Set(doc, fields, firestore.MergeAll)
	})
	if err != nil {
		log.Printf("❌ Error saving document to Firestore: %v", err)
		return err
	}

	log.Printf("✅ Successfully stored %d samples for run ID: %s", len(samples), runID)
	return nil
}

func hasFreshness(samples []models.Sample) bool {
	for i := range samples {
		if samples[i].Freshness != nil {
			return true
		}
	}
	return false
}

func stampFreshnessStored(samples []models.Sample, storedAt time.Time) {
	for i := range samples {
		freshness := samples[i].Freshness
		if freshness == nil {
			continue
		}
		freshness.BackendStoredAtUnixMs = storedAt.UnixMilli()
		if !freshness.BackendReceivedAt.IsZero() {
			duration := storedAt.Sub(freshness.BackendReceivedAt).Milliseconds()
			if duration < 0 {
				duration = 0
			}
			freshness.BackendStorageDurationMs = duration
		}
	}
}

// StorePredictionCheckpoint stores or replaces one prediction checkpoint for a run.
func (c *Client) StorePredictionCheckpoint(ctx context.Context, runID string, checkpoint models.PredictionCheckpoint) error {
	doc := c.firestore.Collection("runs").Doc(runID)
	err := c.firestore.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		existing, err := readRunDocInTx(tx, doc)
		if err != nil {
			return err
		}
		var prior []models.PredictionCheckpoint
		if existing != nil {
			prior = existing.PredictionCheckpoints
		}
		return tx.Set(doc, checkpointStoreFields(runID, prior, checkpoint, time.Now()), firestore.MergeAll)
	})
	if err != nil {
		return fmt.Errorf("store prediction checkpoint for run %s: %w", runID, err)
	}
	return nil
}

// AppendProcessForecasts appends public-safe process forecast issuances for a run.
func (c *Client) AppendProcessForecasts(ctx context.Context, runID string, forecasts []models.ProcessForecast) error {
	if len(forecasts) == 0 {
		return nil
	}
	doc := c.firestore.Collection("runs").Doc(runID)
	err := c.firestore.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		existing, err := readRunDocInTx(tx, doc)
		if err != nil {
			return err
		}
		var prior []models.ProcessForecast
		if existing != nil {
			prior = existing.ProcessForecasts
		}
		return tx.Set(doc, forecastStoreFields(runID, prior, forecasts, time.Now()), firestore.MergeAll)
	})
	if err != nil {
		return fmt.Errorf("append process forecasts for run %s: %w", runID, err)
	}
	return nil
}

// StoreProcessInfo stores or updates process information (VM flags) for a process in the processes collection
func (c *Client) StoreProcessInfo(ctx context.Context, runID string, processInfo models.ProcessInfo) error {
	log.Printf("🔄 Storing process info for PID: %s (Name: %s) in run ID: %s", processInfo.PID, processInfo.Name, runID)

	doc := c.firestore.Collection("processes").Doc(runID)
	err := c.firestore.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		existing, err := readProcessDocInTx(tx, doc)
		if err != nil {
			return err
		}
		if existing != nil {
			log.Printf("📄 Found existing process document for run ID: %s", runID)
			if _, exists := existing.ProcessInfo[processInfo.PID]; exists {
				log.Printf("📝 Updating existing process info for PID: %s", processInfo.PID)
			} else {
				log.Printf("➕ Adding new process info for PID: %s", processInfo.PID)
			}
		} else {
			log.Printf("📄 Creating new process document for run ID: %s", runID)
			log.Printf("➕ Adding new process info for PID: %s", processInfo.PID)
		}
		return tx.Set(doc, processInfoStoreFields(runID, existing, processInfo, time.Now()), firestore.MergeAll)
	})
	if err != nil {
		log.Printf("❌ Error saving process info to Firestore: %v", err)
		return err
	}

	log.Printf("✅ Successfully stored process info for PID: %s in run ID: %s", processInfo.PID, runID)
	return nil
}

func readRunDocInTx(tx *firestore.Transaction, doc *firestore.DocumentRef) (*models.RunDoc, error) {
	snapshot, err := tx.Get(doc)
	if err != nil {
		if status.Code(err) == codes.NotFound {
			return nil, nil
		}
		return nil, err
	}
	if !snapshot.Exists() {
		return nil, nil
	}
	var runDoc models.RunDoc
	if err := snapshot.DataTo(&runDoc); err != nil {
		return nil, err
	}
	return &runDoc, nil
}

func readProcessDocInTx(tx *firestore.Transaction, doc *firestore.DocumentRef) (*models.ProcessDoc, error) {
	snapshot, err := tx.Get(doc)
	if err != nil {
		if status.Code(err) == codes.NotFound {
			return nil, nil
		}
		return nil, err
	}
	if !snapshot.Exists() {
		return nil, nil
	}
	var processDoc models.ProcessDoc
	if err := snapshot.DataTo(&processDoc); err != nil {
		return nil, err
	}
	return &processDoc, nil
}

// GetProcesses retrieves process information for a run from the processes collection.
func (c *Client) GetProcesses(ctx context.Context, runID string) (*models.ProcessDoc, error) {
	doc := c.firestore.Collection("processes").Doc(runID)
	snapshot, err := doc.Get(ctx)
	if err != nil {
		return nil, err
	}

	if !snapshot.Exists() {
		// Return empty ProcessDoc if not found (not an error)
		return &models.ProcessDoc{
			RunID:       runID,
			ProcessInfo: make(map[string]models.ProcessInfo),
		}, nil
	}

	var processDoc models.ProcessDoc
	if err := snapshot.DataTo(&processDoc); err != nil {
		return nil, err
	}

	return &processDoc, nil
}

// MarkRunAsFinished marks a run as finished. newlyFinished is true when this call transitioned the run to finished (so callers can enqueue async work such as BigQuery export).
func (c *Client) MarkRunAsFinished(ctx context.Context, runID string) (newlyFinished bool, err error) {
	doc := c.firestore.Collection("runs").Doc(runID)
	var transitioned bool
	err = c.firestore.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		transitioned = false
		existing, err := readRunDocInTx(tx, doc)
		if err != nil {
			return err
		}
		if existing == nil {
			log.Printf("Run %s did not exist at finish time; creating finished empty run", runID)
		} else if existing.Finished {
			log.Printf("Run %s is already finished", runID)
			return nil
		}
		now := time.Now()
		transitioned = true
		return tx.Set(doc, finishStoreFields(runID, existing, now), firestore.MergeAll)
	})
	if err != nil {
		return false, err
	}
	return transitioned, nil
}

// FindStaleRuns finds runs that haven't been updated within the timeout period
func (c *Client) FindStaleRuns(ctx context.Context, timeout time.Duration) ([]string, error) {
	iter := c.firestore.Collection("runs").Documents(ctx)

	var staleRuns []string
	for {
		doc, err := iter.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			return nil, err
		}

		var runDoc models.RunDoc
		if err := doc.DataTo(&runDoc); err != nil {
			log.Printf("❌ Error parsing run document %s: %v", doc.Ref.ID, err)
			continue
		}

		// Skip if already finished
		if runDoc.Finished {
			continue
		}

		// Check if this run is stale
		timeSinceLastUpdate := time.Since(runDoc.UpdatedAt)
		if timeSinceLastUpdate > timeout {
			staleRuns = append(staleRuns, doc.Ref.ID)
		}
	}

	return staleRuns, nil
}

// DeleteOldRuns deletes runs older than the retention period
// Uses finished_at if available, otherwise uses created_at + retention period
func (c *Client) DeleteOldRuns(ctx context.Context, retentionPeriod time.Duration) ([]string, error) {
	cutoffTime := time.Now().Add(-retentionPeriod)
	cutoffTimestamp := ToMillis(cutoffTime)

	log.Printf("🗑️ Deleting data older than: %v (timestamp: %d)", cutoffTime, cutoffTimestamp)

	// Get all runs - we need to check each one individually because we need to check
	// finished_at if available, otherwise created_at
	iter := c.firestore.Collection("runs").Documents(ctx)

	var deletedRuns []string
	for {
		doc, err := iter.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			return deletedRuns, err
		}

		var runDoc models.RunDoc
		if err := doc.DataTo(&runDoc); err != nil {
			log.Printf("❌ Error parsing run document %s: %v", doc.Ref.ID, err)
			continue
		}

		// Determine the timestamp to use for comparison
		var compareTime time.Time
		if !runDoc.FinishedAt.IsZero() {
			// Use finished_at if the run is finished
			compareTime = runDoc.FinishedAt
		} else {
			// Use created_at if the run never finished
			compareTime = runDoc.CreatedAt
		}

		// Check if this run should be deleted (older than retention period)
		if compareTime.Before(cutoffTime) {
			// Delete the document
			_, err = doc.Ref.Delete(ctx)
			if err != nil {
				log.Printf("❌ Error deleting old run %s: %v", doc.Ref.ID, err)
				continue
			}

			deletedRuns = append(deletedRuns, doc.Ref.ID)
			log.Printf("🗑️ Deleted old run: %s (created: %v, finished: %v)", doc.Ref.ID, runDoc.CreatedAt, runDoc.FinishedAt)
		}
	}

	return deletedRuns, nil
}

// ParseData parses the monitoring data string into samples
func ParseData(data string, startTime time.Time) ([]models.Sample, error) {
	var samples []models.Sample
	lines := strings.Split(strings.TrimSpace(data), "\n")

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		parts := strings.Split(line, "|")
		if len(parts) != 6 && len(parts) != 7 && len(parts) != 14 {
			continue
		}

		// Trim whitespace from all parts
		for i := range parts {
			parts[i] = strings.TrimSpace(parts[i])
		}

		// Parse elapsed time from "HH:MM:SS" format
		timeParts := strings.Split(parts[0], ":")
		if len(timeParts) != 3 {
			continue
		}
		hours, err1 := strconv.Atoi(timeParts[0])
		minutes, err2 := strconv.Atoi(timeParts[1])
		seconds, err3 := strconv.Atoi(timeParts[2])
		if err1 != nil || err2 != nil || err3 != nil {
			continue
		}
		elapsedTime := hours*3600 + minutes*60 + seconds

		// Parse heap used (remove "MB" suffix and convert float to int)
		heapUsedStr := strings.TrimSuffix(strings.TrimSuffix(parts[3], "MB"), "MB")
		heapUsedFloat, err := strconv.ParseFloat(heapUsedStr, 64)
		if err != nil {
			continue
		}
		heapUsed := int(heapUsedFloat)

		// Parse heap capacity (remove "MB" suffix and convert float to int)
		heapCapStr := strings.TrimSuffix(strings.TrimSuffix(parts[4], "MB"), "MB")
		heapCapFloat, err := strconv.ParseFloat(heapCapStr, 64)
		if err != nil {
			continue
		}
		heapCap := int(heapCapFloat)

		// Parse RSS (remove "MB" suffix and convert float to int)
		rssStr := strings.TrimSuffix(strings.TrimSuffix(parts[5], "MB"), "MB")
		rssFloat, err := strconv.ParseFloat(rssStr, 64)
		if err != nil {
			continue
		}
		rss := int(rssFloat)

		// Parse GC time if present (7th part)
		// Format can be either "0.234s" (seconds) or legacy "234ms" (milliseconds)
		var gcTime int
		if len(parts) >= 7 {
			gcTimeStr := parts[6]
			isMilliseconds := strings.HasSuffix(gcTimeStr, "ms")
			isSeconds := !isMilliseconds && strings.HasSuffix(gcTimeStr, "s")

			// Remove suffix (either "s" or "ms")
			if isMilliseconds {
				gcTimeStr = strings.TrimSuffix(gcTimeStr, "ms")
			} else if isSeconds {
				gcTimeStr = strings.TrimSuffix(gcTimeStr, "s")
			}

			if gcTimeStr != "N/A" && gcTimeStr != "" {
				gcTimeFloat, err := strconv.ParseFloat(gcTimeStr, 64)
				if err != nil {
					gcTime = 0
				} else if isSeconds {
					gcTime = int(gcTimeFloat * 1000) // Convert seconds to milliseconds
				} else {
					gcTime = int(gcTimeFloat) // Already in milliseconds
				}
			}
		}

		parseOptionalInt := func(index int, secondsToMillis bool) *int {
			if index >= len(parts) || parts[index] == "" || parts[index] == "N/A" {
				return nil
			}
			value, err := strconv.ParseFloat(strings.TrimSuffix(parts[index], "s"), 64)
			if err != nil {
				return nil
			}
			if secondsToMillis {
				value *= 1000
			}
			parsed := int(value)
			return &parsed
		}

		// Calculate consistent timestamp using startTime + elapsedTime
		// This ensures all samples in the same monitoring cycle have the same timestamp
		timestamp := startTime.Add(time.Duration(elapsedTime) * time.Second)

		sample := models.Sample{
			Timestamp:                  ToMillis(timestamp),
			ElapsedTime:                elapsedTime,
			PID:                        parts[1],
			Name:                       parts[2],
			HeapUsed:                   heapUsed,
			HeapCap:                    heapCap,
			RSS:                        rss,
			GCTime:                     gcTime,
			JITCompiledMethods:         parseOptionalInt(7, false),
			JITFailedCompilations:      parseOptionalInt(8, false),
			JITInvalidatedCompilations: parseOptionalInt(9, false),
			JITCompilationTimeMs:       parseOptionalInt(10, true),
			ClassesLoaded:              parseOptionalInt(11, false),
			ClassesUnloaded:            parseOptionalInt(12, false),
			ClassLoadTimeMs:            parseOptionalInt(13, true),
		}

		samples = append(samples, sample)
	}

	return samples, nil
}

// ToMillis converts a time.Time to Unix milliseconds
func ToMillis(t time.Time) int64 {
	return t.UnixNano() / int64(time.Millisecond)
}
