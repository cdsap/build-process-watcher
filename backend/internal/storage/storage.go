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
)

// Client wraps Firestore operations
type Client struct {
	firestore *firestore.Client
	ctx       context.Context
}

// NewClient creates a new storage client
func NewClient(ctx context.Context, projectID string) (*Client, error) {
	client, err := firestore.NewClient(ctx, projectID)
	if err != nil {
		return nil, fmt.Errorf("failed to create Firestore client: %w", err)
	}

	log.Printf("✅ Connected to Firestore project: %s", projectID)
	return &Client{
		firestore: client,
		ctx:       ctx,
	}, nil
}

// Close closes the Firestore client
func (c *Client) Close() error {
	return c.firestore.Close()
}

// GetRun retrieves a run document by ID
func (c *Client) GetRun(runID string) (*models.RunDoc, error) {
	doc := c.firestore.Collection("runs").Doc(runID)
	snapshot, err := doc.Get(c.ctx)
	if err != nil {
		return nil, err
	}

	if !snapshot.Exists() {
		return nil, fmt.Errorf("run %s not found", runID)
	}

	var runDoc models.RunDoc
	if err := snapshot.DataTo(&runDoc); err != nil {
		return nil, err
	}

	return &runDoc, nil
}

// StoreSamples stores samples for a run
func (c *Client) StoreSamples(runID string, samples []models.Sample) error {
	log.Printf("🔄 Storing %d samples for run ID: %s", len(samples), runID)
	
	doc := c.firestore.Collection("runs").Doc(runID)

	// Get existing document or create new one
	snapshot, err := doc.Get(c.ctx)
	if err != nil && !strings.Contains(err.Error(), "not found") {
		log.Printf("❌ Error getting document: %v", err)
		return err
	}

	var runDoc models.RunDoc
	if snapshot != nil && snapshot.Exists() {
		if err := snapshot.DataTo(&runDoc); err != nil {
			log.Printf("❌ Error parsing document data: %v", err)
			return err
		}
		log.Printf("📄 Found existing document with %d samples", len(runDoc.Samples))
	} else {
		runDoc = models.RunDoc{
			ID:        runID,
			RunID:     runID,
			StartTime: time.Now(),
			CreatedAt: time.Now(),
		}
		log.Printf("📄 Creating new document for run ID: %s", runID)
	}

	// Append new samples
	runDoc.Samples = append(runDoc.Samples, samples...)
	now := time.Now()
	runDoc.UpdatedAt = now
	runDoc.UpdatedAtTimestamp = ToMillis(now) // Store Unix millis for timezone-independent queries
	log.Printf("📊 Document now has %d samples total", len(runDoc.Samples))

	// Save back to Firestore
	_, err = doc.Set(c.ctx, runDoc)
	if err != nil {
		log.Printf("❌ Error saving document to Firestore: %v", err)
		return err
	}
	
	log.Printf("✅ Successfully stored %d samples for run ID: %s", len(samples), runID)
	return nil
}

// MarkRunAsFinished marks a run as finished
func (c *Client) MarkRunAsFinished(runID string) error {
	doc := c.firestore.Collection("runs").Doc(runID)
	snapshot, err := doc.Get(c.ctx)
	if err != nil {
		return err
	}

	if !snapshot.Exists() {
		return fmt.Errorf("run %s not found", runID)
	}

	var runDoc models.RunDoc
	if err := snapshot.DataTo(&runDoc); err != nil {
		return err
	}

	// If already finished, nothing to do
	if runDoc.Finished {
		log.Printf("Run %s is already finished", runID)
		return nil
	}

	// Mark as finished
	now := time.Now()
	runDoc.Finished = true
	runDoc.FinishedAt = now
	runDoc.UpdatedAt = now
	runDoc.UpdatedAtTimestamp = ToMillis(now) // Store Unix millis for timezone-independent queries

	// Update in Firestore
	_, err = doc.Set(c.ctx, runDoc)
	if err != nil {
		return err
	}

	return nil
}

// FindStaleRuns finds runs that haven't been updated within the timeout period
func (c *Client) FindStaleRuns(timeout time.Duration) ([]string, error) {
	iter := c.firestore.Collection("runs").Documents(c.ctx)
	
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
func (c *Client) DeleteOldRuns(retentionPeriod time.Duration) ([]string, error) {
	cutoffTime := time.Now().Add(-retentionPeriod)
	cutoffTimestamp := ToMillis(cutoffTime)
	
	log.Printf("🗑️ Deleting data older than: %v (timestamp: %d)", cutoffTime, cutoffTimestamp)
	
	// Query for old runs using timestamp field for timezone-independent comparison
	query := c.firestore.Collection("runs").Where("updated_at_timestamp", "<", cutoffTimestamp)
	iter := query.Documents(c.ctx)
	
	var deletedRuns []string
	for {
		doc, err := iter.Next()
		if err == iterator.Done {
			break
		}
		if err != nil {
			return deletedRuns, err
		}
		
		// Delete the document
		_, err = doc.Ref.Delete(c.ctx)
		if err != nil {
			log.Printf("❌ Error deleting old run %s: %v", doc.Ref.ID, err)
			continue
		}
		
		deletedRuns = append(deletedRuns, doc.Ref.ID)
		log.Printf("🗑️ Deleted old run: %s", doc.Ref.ID)
	}
	
	return deletedRuns, nil
}

// ParseData parses the monitoring data string into samples
func ParseData(data string, startTime time.Time) ([]models.Sample, error) {
	var samples []models.Sample
	lines := strings.Split(strings.TrimSpace(data), "\n")
	
	log.Printf("=== PARSING DATA ===")
	log.Printf("Raw data: %q", data)
	log.Printf("Split into %d lines", len(lines))

	for i, line := range lines {
		line = strings.TrimSpace(line)
		log.Printf("Processing line %d: %q", i, line)
		if line == "" {
			log.Printf("Skipping empty line %d", i)
			continue
		}

		parts := strings.Split(line, "|")
		log.Printf("Split into %d parts: %v", len(parts), parts)
		if len(parts) != 6 && len(parts) != 7 {
			log.Printf("Skipping line %d: expected 6 or 7 parts, got %d", i, len(parts))
			continue
		}

		// Trim whitespace from all parts
		for i := range parts {
			parts[i] = strings.TrimSpace(parts[i])
		}

		// Parse elapsed time from "HH:MM:SS" format
		log.Printf("Parsing time: %q", parts[0])
		timeParts := strings.Split(parts[0], ":")
		if len(timeParts) != 3 {
			log.Printf("Skipping: invalid time format, got %d parts", len(timeParts))
			continue
		}
		hours, err1 := strconv.Atoi(timeParts[0])
		minutes, err2 := strconv.Atoi(timeParts[1])
		seconds, err3 := strconv.Atoi(timeParts[2])
		if err1 != nil || err2 != nil || err3 != nil {
			log.Printf("Skipping: time parsing failed: %v, %v, %v", err1, err2, err3)
			continue
		}
		elapsedTime := hours*3600 + minutes*60 + seconds
		log.Printf("Parsed elapsed time: %d seconds", elapsedTime)

		// Parse heap used (remove "MB" suffix and convert float to int)
		heapUsedStr := strings.TrimSuffix(strings.TrimSuffix(parts[3], "MB"), "MB")
		heapUsedFloat, err := strconv.ParseFloat(heapUsedStr, 64)
		if err != nil {
			log.Printf("Skipping: heap used parsing failed: %v", err)
			continue
		}
		heapUsed := int(heapUsedFloat)

		// Parse heap capacity (remove "MB" suffix and convert float to int)
		heapCapStr := strings.TrimSuffix(strings.TrimSuffix(parts[4], "MB"), "MB")
		heapCapFloat, err := strconv.ParseFloat(heapCapStr, 64)
		if err != nil {
			log.Printf("Skipping: heap capacity parsing failed: %v", err)
			continue
		}
		heapCap := int(heapCapFloat)

		// Parse RSS (remove "MB" suffix and convert float to int)
		rssStr := strings.TrimSuffix(strings.TrimSuffix(parts[5], "MB"), "MB")
		rssFloat, err := strconv.ParseFloat(rssStr, 64)
		if err != nil {
			log.Printf("Skipping: RSS parsing failed: %v", err)
			continue
		}
		rss := int(rssFloat)

		// Parse GC time if present (7th part)
		var gcTime int
		if len(parts) == 7 {
			gcTimeStr := strings.TrimSuffix(strings.TrimSuffix(parts[6], "ms"), "ms")
			if gcTimeStr != "N/A" && gcTimeStr != "" {
				gcTimeFloat, err := strconv.ParseFloat(gcTimeStr, 64)
				if err != nil {
					log.Printf("Warning: GC time parsing failed: %v, using 0", err)
					gcTime = 0
				} else {
					gcTime = int(gcTimeFloat)
				}
			}
		}

		// Calculate consistent timestamp using startTime + elapsedTime
		// This ensures all samples in the same monitoring cycle have the same timestamp
		timestamp := startTime.Add(time.Duration(elapsedTime) * time.Second)

		sample := models.Sample{
			Timestamp:   ToMillis(timestamp),
			ElapsedTime: elapsedTime,
			PID:         parts[1],
			Name:        parts[2],
			HeapUsed:    heapUsed,
			HeapCap:     heapCap,
			RSS:         rss,
			GCTime:      gcTime,
		}

		log.Printf("Created sample: %+v", sample)
		samples = append(samples, sample)
	}

	return samples, nil
}

// ToMillis converts a time.Time to Unix milliseconds
func ToMillis(t time.Time) int64 {
	return t.UnixNano() / int64(time.Millisecond)
}

