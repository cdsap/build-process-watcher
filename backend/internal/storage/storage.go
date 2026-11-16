package storage

import (
	"context"
	"fmt"
	"log"
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

// SampleBuildFunc builds samples once the run start_time is known from the
// transactional read (or time.Now for a new run).
type SampleBuildFunc func(startTime time.Time) ([]models.Sample, error)

// SampleAppendResult summarizes one AppendSamples call after a single read.
type SampleAppendResult struct {
	Count                 int
	PredictionMode        string
	PredictiveReliability bool
}

// AppendSamples reads the run once inside a transaction, builds samples with the
// resolved start_time, then MergeAll-appends them. Callers that previously did
// GetRun + ParseData + StoreSamples should use this to avoid the double full read.
func (c *Client) AppendSamples(ctx context.Context, runID string, build SampleBuildFunc) (*SampleAppendResult, error) {
	if build == nil {
		return nil, fmt.Errorf("sample build func is required")
	}
	log.Printf("🔄 Appending samples for run ID: %s", runID)

	result := &SampleAppendResult{}
	doc := c.firestore.Collection("runs").Doc(runID)
	err := c.firestore.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		existing, err := readRunDocInTx(tx, doc)
		if err != nil {
			return err
		}
		startTime := time.Now()
		if existing != nil && !existing.StartTime.IsZero() {
			startTime = existing.StartTime
		}
		samples, err := build(startTime)
		if err != nil {
			return err
		}
		now := time.Now()
		fields := sampleStoreFields(runID, existing, samples, now)
		if existing != nil {
			log.Printf("📄 Found existing document with %d samples", len(existing.Samples))
			result.PredictionMode = existing.PredictionMode
			result.PredictiveReliability = existing.PredictiveReliability
		} else {
			log.Printf("📄 Creating new document for run ID: %s", runID)
		}
		result.Count = len(samples)
		if merged, ok := fields["samples"].([]models.Sample); ok {
			log.Printf("📊 Document now has %d samples total", len(merged))
		}
		return tx.Set(doc, fields, firestore.MergeAll)
	})
	if err != nil {
		log.Printf("❌ Error saving document to Firestore: %v", err)
		return nil, err
	}

	log.Printf("✅ Successfully stored %d samples for run ID: %s", result.Count, runID)
	return result, nil
}

// StoreSamples appends already-parsed samples (tests and callers that own timestamps).
func (c *Client) StoreSamples(ctx context.Context, runID string, samples []models.Sample) error {
	_, err := c.AppendSamples(ctx, runID, func(time.Time) ([]models.Sample, error) {
		return samples, nil
	})
	return err
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

// ToMillis converts a time.Time to Unix milliseconds
func ToMillis(t time.Time) int64 {
	return t.UnixNano() / int64(time.Millisecond)
}
