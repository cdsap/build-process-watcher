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
	if stats[0].PartialData != 0 || stats[0].NoData != 0 || stats[0].ProviderError != 0 || stats[0].ModelUnavailable != 0 {
		t.Fatalf("success state counters = %+v", stats[0])
	}
	if stats[0].LatencyBuckets[telemetry.BucketUnder50ms] != 1 {
		t.Fatalf("latency buckets = %#v", stats[0].LatencyBuckets)
	}
}

func TestProviderTelemetryPartialDataPath(t *testing.T) {
	store := telemetry.NewStore()
	p := New(Config{ModelVersion: "model-partial", Telemetry: store})

	var logBuf bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&logBuf)
	defer log.SetOutput(prev)

	checkpoint, err := p.Predict(context.Background(), predictor.RunSnapshot{
		RunID: "run-partial",
		Samples: []predictor.Sample{
			{ElapsedTime: 10},
			{ElapsedTime: 30},
		},
	}, 60)
	if err != nil {
		t.Fatal(err)
	}
	if checkpoint.RiskLevel != "unknown" || checkpoint.Message != publicLimitedMessage {
		t.Fatalf("checkpoint = %+v, want partial-data limited scoring", checkpoint)
	}
	if strings.Contains(checkpoint.Message, "threshold") || strings.Contains(checkpoint.Message, "formula") {
		t.Fatalf("public message leaked internals: %q", checkpoint.Message)
	}

	stats := store.Snapshot()
	if len(stats) != 1 || stats[0].Success != 1 || stats[0].PartialData != 1 {
		t.Fatalf("partial-data stats = %+v", stats)
	}
	if !strings.Contains(logBuf.String(), "state=partial_data") {
		t.Fatalf("logs missing partial_data state: %s", logBuf.String())
	}
	if !strings.Contains(logBuf.String(), "partial-data:") {
		t.Fatalf("logs missing partial-data diagnostic: %s", logBuf.String())
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
	if !errors.Is(err, ErrScoringTimeout) {
		t.Fatalf("err = %v, want ErrScoringTimeout", err)
	}
	if checkpoint.Message != "" {
		t.Fatalf("checkpoint message = %q, want empty on error", checkpoint.Message)
	}
	if strings.Contains(err.Error(), "hook unexpectedly") {
		t.Fatal("returned error leaked private hook detail")
	}
	if !strings.Contains(logBuf.String(), "outcome=timeout") || !strings.Contains(logBuf.String(), "state=model_unavailable") {
		t.Fatalf("logs missing timeout/model_unavailable telemetry: %s", logBuf.String())
	}
	if !strings.Contains(logBuf.String(), "model-unavailable: live scoring timed out:") {
		t.Fatalf("logs missing private timeout diagnostic: %s", logBuf.String())
	}

	stats := store.Snapshot()
	if len(stats) != 1 || stats[0].Timeout != 1 || stats[0].ModelUnavailable != 1 || stats[0].Attempts != 1 {
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
	if !errors.Is(err, ErrScoringFailed) {
		t.Fatalf("err = %v, want ErrScoringFailed", err)
	}
	if strings.Contains(err.Error(), "bigquery") || strings.Contains(err.Error(), "missing model") {
		t.Fatal("returned error leaked private scoring detail")
	}
	if !strings.Contains(logBuf.String(), "outcome=error") || !strings.Contains(logBuf.String(), "state=provider_error") {
		t.Fatalf("logs missing error/provider_error telemetry: %s", logBuf.String())
	}
	if !strings.Contains(logBuf.String(), "provider-error: bigquery ml private detail: missing model table") {
		t.Fatalf("logs missing private diagnostic context: %s", logBuf.String())
	}

	stats := store.Snapshot()
	if len(stats) != 1 || stats[0].Error != 1 || stats[0].ProviderError != 1 || stats[0].Attempts != 1 {
		t.Fatalf("error stats = %+v", stats)
	}
	if stats[0].ModelVersion != "model-error" {
		t.Fatalf("model version = %q, want model-error", stats[0].ModelVersion)
	}
}

func TestProviderTelemetryNoDataPath(t *testing.T) {
	store := telemetry.NewStore()
	p := New(Config{ModelVersion: "model-nodata", Telemetry: store})

	var logBuf bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&logBuf)
	defer log.SetOutput(prev)

	_, err := p.Predict(context.Background(), predictor.RunSnapshot{RunID: "run-nodata"}, 60)
	if err == nil {
		t.Fatal("expected no-data error")
	}
	if !errors.Is(err, ErrNoData) {
		t.Fatalf("err = %v, want ErrNoData", err)
	}

	stats := store.Snapshot()
	if len(stats) != 1 || stats[0].Error != 1 || stats[0].NoData != 1 {
		t.Fatalf("no-data stats = %+v", stats)
	}
	if !strings.Contains(logBuf.String(), "state=no_data") {
		t.Fatalf("logs missing no_data state: %s", logBuf.String())
	}
}

func TestProviderTelemetryModelUnavailablePath(t *testing.T) {
	store := telemetry.NewStore()
	p := New(Config{ModelVersion: "model-missing", Telemetry: store})
	p.scoreHook = func(context.Context, features.CheckpointRow, int) (scoredValues, error) {
		return scoredValues{}, ErrModelUnavailable
	}

	var logBuf bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&logBuf)
	defer log.SetOutput(prev)

	_, err := p.Predict(context.Background(), predictor.RunSnapshot{
		RunID:   "run-model-missing",
		Samples: []predictor.Sample{{ElapsedTime: 60, RSS: 1024}},
	}, 60)
	if !errors.Is(err, ErrModelUnavailable) {
		t.Fatalf("err = %v, want ErrModelUnavailable", err)
	}

	stats := store.Snapshot()
	if len(stats) != 1 || stats[0].Error != 1 || stats[0].ModelUnavailable != 1 {
		t.Fatalf("model-unavailable stats = %+v", stats)
	}
	if !strings.Contains(logBuf.String(), "state=model_unavailable") {
		t.Fatalf("logs missing model_unavailable state: %s", logBuf.String())
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
