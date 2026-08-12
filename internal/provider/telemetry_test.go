package provider

import (
	"bytes"
	"context"
	"errors"
	"log"
	"strings"
	"testing"
	"time"

	"github.com/cdsap/build-process-watcher-predictive-provider/internal/features"
	"github.com/cdsap/build-process-watcher-predictive-provider/internal/telemetry"
	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
)

func TestProviderTelemetrySuccessPath(t *testing.T) {
	store := telemetry.NewStore()
	p := New(Config{
		ProviderID:   "provider-test",
		ModelVersion: "model-success",
		Telemetry:    store,
	})

	checkpoint, err := p.Predict(context.Background(), predictor.RunSnapshot{
		RunID: "run-success",
		Samples: []predictor.Sample{
			{ElapsedTime: 10, RSS: 512},
			{ElapsedTime: 60, RSS: 768},
		},
	}, 60)
	if err != nil {
		t.Fatal(err)
	}
	if checkpoint.Status != "ready" {
		t.Fatalf("Status = %q, want ready", checkpoint.Status)
	}
	if checkpoint.Message != publicReadyMessage {
		t.Fatalf("Message = %q, want public-safe ready message", checkpoint.Message)
	}

	stats := store.Snapshot()
	if len(stats) != 1 {
		t.Fatalf("stats len = %d, want 1", len(stats))
	}
	if stats[0].ObservationWindowS != 60 || stats[0].ModelVersion != "model-success" {
		t.Fatalf("stats key = %+v", stats[0])
	}
	if stats[0].Attempts != 1 || stats[0].Success != 1 || stats[0].Skipped != 0 || stats[0].Timeout != 0 || stats[0].Error != 0 {
		t.Fatalf("success stats = %+v", stats[0])
	}
	if stats[0].LatencyBuckets[telemetry.BucketUnder50ms] != 1 {
		t.Fatalf("latency buckets = %#v", stats[0].LatencyBuckets)
	}
}

func TestProviderTelemetrySkippedPath(t *testing.T) {
	store := telemetry.NewStore()
	p := New(Config{ModelVersion: "model-skip", Telemetry: store})

	checkpoint, err := p.Predict(context.Background(), predictor.RunSnapshot{
		RunID: "run-skip",
		Samples: []predictor.Sample{
			{ElapsedTime: 300, RSS: 1024},
		},
		ExistingCheckpoints: []predictor.PredictionCheckpoint{
			{ObservationWindowS: 300, Status: "ready"},
		},
	}, 300)
	if err != nil {
		t.Fatal(err)
	}
	if checkpoint.Status != "skipped" || checkpoint.Message != publicSkippedMessage {
		t.Fatalf("checkpoint = %+v, want public-safe skipped", checkpoint)
	}

	stats := store.Snapshot()
	if len(stats) != 1 || stats[0].Skipped != 1 || stats[0].Attempts != 1 {
		t.Fatalf("skipped stats = %+v", stats)
	}
	if stats[0].ObservationWindowS != 300 || stats[0].ModelVersion != "model-skip" {
		t.Fatalf("stats key = %+v", stats[0])
	}
}

func TestProviderTelemetryTimeoutPath(t *testing.T) {
	store := telemetry.NewStore()
	p := New(Config{
		ModelVersion: "model-timeout",
		ScoreTimeout: 20 * time.Millisecond,
		Telemetry:    store,
	})
	p.scoreHook = func(ctx context.Context, _ features.CheckpointRow, _ int) (scoredValues, error) {
		timer := time.NewTimer(200 * time.Millisecond)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return scoredValues{}, ctx.Err()
		case <-timer.C:
			return scoredValues{}, errors.New("hook unexpectedly finished")
		}
	}

	var logBuf bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&logBuf)
	defer log.SetOutput(prev)

	checkpoint, err := p.Predict(context.Background(), predictor.RunSnapshot{
		RunID:   "run-timeout",
		Samples: []predictor.Sample{{ElapsedTime: 60, RSS: 1024}},
	}, 60)
	if err == nil {
		t.Fatal("expected timeout error")
	}
	if err.Error() != "scoring timed out" {
		t.Fatalf("err = %v, want generic timeout error", err)
	}
	if checkpoint.Message != "" {
		t.Fatalf("checkpoint message = %q, want empty on error", checkpoint.Message)
	}
	if strings.Contains(err.Error(), "hook unexpectedly") {
		t.Fatal("returned error leaked private hook detail")
	}
	if !strings.Contains(logBuf.String(), "outcome=timeout") {
		t.Fatalf("logs missing timeout telemetry: %s", logBuf.String())
	}
	if !strings.Contains(logBuf.String(), "live scoring timed out:") {
		t.Fatalf("logs missing private timeout diagnostic: %s", logBuf.String())
	}

	stats := store.Snapshot()
	if len(stats) != 1 || stats[0].Timeout != 1 || stats[0].Attempts != 1 {
		t.Fatalf("timeout stats = %+v", stats)
	}
	if stats[0].ModelVersion != "model-timeout" || stats[0].ObservationWindowS != 60 {
		t.Fatalf("stats key = %+v", stats[0])
	}
}

func TestProviderTelemetryScoringErrorPath(t *testing.T) {
	store := telemetry.NewStore()
	p := New(Config{
		ModelVersion: "model-error",
		Telemetry:    store,
	})
	p.scoreHook = func(context.Context, features.CheckpointRow, int) (scoredValues, error) {
		return scoredValues{}, errors.New("bigquery ml private detail: missing model table")
	}

	var logBuf bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&logBuf)
	defer log.SetOutput(prev)

	_, err := p.Predict(context.Background(), predictor.RunSnapshot{
		RunID:   "run-error",
		Samples: []predictor.Sample{{ElapsedTime: 60, RSS: 1024}},
	}, 60)
	if err == nil {
		t.Fatal("expected scoring error")
	}
	if err.Error() != "scoring failed" {
		t.Fatalf("err = %v, want generic scoring failed", err)
	}
	if strings.Contains(err.Error(), "bigquery") || strings.Contains(err.Error(), "missing model") {
		t.Fatal("returned error leaked private scoring detail")
	}
	if !strings.Contains(logBuf.String(), "outcome=error") {
		t.Fatalf("logs missing error telemetry: %s", logBuf.String())
	}
	if !strings.Contains(logBuf.String(), "bigquery ml private detail: missing model table") {
		t.Fatalf("logs missing private diagnostic context: %s", logBuf.String())
	}

	stats := store.Snapshot()
	if len(stats) != 1 || stats[0].Error != 1 || stats[0].Attempts != 1 {
		t.Fatalf("error stats = %+v", stats)
	}
	if stats[0].ModelVersion != "model-error" {
		t.Fatalf("model version = %q, want model-error", stats[0].ModelVersion)
	}
}

func TestProviderTelemetryReviewsMultipleWindowsAndModels(t *testing.T) {
	store := telemetry.NewStore()
	p60 := New(Config{ModelVersion: "v60", Telemetry: store})
	p300 := New(Config{ModelVersion: "v300", Telemetry: store})

	if _, err := p60.Predict(context.Background(), predictor.RunSnapshot{
		Samples: []predictor.Sample{{ElapsedTime: 60, RSS: 900}},
	}, 60); err != nil {
		t.Fatal(err)
	}
	if _, err := p300.Predict(context.Background(), predictor.RunSnapshot{
		Samples: []predictor.Sample{{ElapsedTime: 300, RSS: 1100}},
		ExistingCheckpoints: []predictor.PredictionCheckpoint{
			{ObservationWindowS: 300},
		},
	}, 300); err != nil {
		t.Fatal(err)
	}

	stats := store.Snapshot()
	if len(stats) != 2 {
		t.Fatalf("stats len = %d, want 2", len(stats))
	}
	if stats[0].ObservationWindowS != 60 || stats[0].ModelVersion != "v60" || stats[0].Success != 1 {
		t.Fatalf("first stats = %+v", stats[0])
	}
	if stats[1].ObservationWindowS != 300 || stats[1].ModelVersion != "v300" || stats[1].Skipped != 1 {
		t.Fatalf("second stats = %+v", stats[1])
	}
}
