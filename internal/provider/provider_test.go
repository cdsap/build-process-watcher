package provider

import (
	"context"
	"testing"
	"time"

	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
)

func TestProviderSatisfiesPredictionContract(t *testing.T) {
	now := time.Unix(123, 0).UTC()
	checkpoint, err := New(Config{
		ProviderID:   "provider-test",
		ModelVersion: "opaque-test",
	}).Predict(context.Background(), predictor.RunSnapshot{
		RunID: "run-1",
		Now:   now,
		Samples: []predictor.Sample{
			{ElapsedTime: 10, RSS: 512},
			{ElapsedTime: 60, RSS: 768},
		},
	}, 60)
	if err != nil {
		t.Fatal(err)
	}

	if checkpoint.ObservationWindowS != 60 {
		t.Fatalf("ObservationWindowS = %d, want 60", checkpoint.ObservationWindowS)
	}
	if checkpoint.Status != "ready" {
		t.Fatalf("Status = %q, want ready", checkpoint.Status)
	}
	if checkpoint.RiskLevel != "low" {
		t.Fatalf("RiskLevel = %q, want low", checkpoint.RiskLevel)
	}
	if checkpoint.ProviderID != "provider-test" {
		t.Fatalf("ProviderID = %q, want provider-test", checkpoint.ProviderID)
	}
	if checkpoint.ModelVersion != "opaque-test" {
		t.Fatalf("ModelVersion = %q, want opaque-test", checkpoint.ModelVersion)
	}
	if !checkpoint.CreatedAt.Equal(now) {
		t.Fatalf("CreatedAt = %v, want %v", checkpoint.CreatedAt, now)
	}
	if checkpoint.PredictedPeakRSSMB == nil || *checkpoint.PredictedPeakRSSMB <= 0 {
		t.Fatalf("PredictedPeakRSSMB = %v, want positive value", checkpoint.PredictedPeakRSSMB)
	}
	if checkpoint.RiskScore == nil {
		t.Fatal("RiskScore = nil, want scored checkpoint")
	}
	if checkpoint.Confidence != "medium" {
		t.Fatalf("Confidence = %q, want medium", checkpoint.Confidence)
	}
}

func TestProviderReturnsElevatedMemorySignal(t *testing.T) {
	checkpoint, err := New(Config{}).Predict(context.Background(), predictor.RunSnapshot{
		Samples: []predictor.Sample{{ElapsedTime: 60, RSS: 3072}},
	}, 60)
	if err != nil {
		t.Fatal(err)
	}

	if checkpoint.RiskLevel != "elevated" {
		t.Fatalf("RiskLevel = %q, want elevated", checkpoint.RiskLevel)
	}
	if checkpoint.Confidence != "low" {
		t.Fatalf("Confidence = %q, want low", checkpoint.Confidence)
	}
	if len(checkpoint.Signals) != 1 || checkpoint.Signals[0] != "high memory pressure" {
		t.Fatalf("Signals = %v, want [high memory pressure]", checkpoint.Signals)
	}
}

func TestProviderReturnsHighRiskForCompoundingRuntimeSignals(t *testing.T) {
	checkpoint, err := New(Config{}).Predict(context.Background(), predictor.RunSnapshot{
		Samples: []predictor.Sample{
			{ElapsedTime: 0, RSS: 512, HeapUsed: 300, HeapCap: 1000, GCTime: 0},
			{ElapsedTime: 30, RSS: 1200, HeapUsed: 760, HeapCap: 1000, GCTime: 3000},
			{ElapsedTime: 60, RSS: 2048, HeapUsed: 900, HeapCap: 1000, GCTime: 10000},
		},
		ProcessInfo: map[string]predictor.ProcessInfo{
			"1": {PID: "1"},
			"2": {PID: "2"},
			"3": {PID: "3"},
			"4": {PID: "4"},
			"5": {PID: "5"},
		},
	}, 60)
	if err != nil {
		t.Fatal(err)
	}

	if checkpoint.RiskLevel != "high" {
		t.Fatalf("RiskLevel = %q, want high", checkpoint.RiskLevel)
	}
	if checkpoint.Confidence != "medium" {
		t.Fatalf("Confidence = %q, want medium", checkpoint.Confidence)
	}
	if checkpoint.RiskScore == nil || *checkpoint.RiskScore < 0.65 {
		t.Fatalf("RiskScore = %v, want >= 0.65", checkpoint.RiskScore)
	}
	wantSignals := []string{"memory pressure", "rapid memory growth", "heap saturation"}
	if len(checkpoint.Signals) != len(wantSignals) {
		t.Fatalf("Signals = %v, want %v", checkpoint.Signals, wantSignals)
	}
	for i, want := range wantSignals {
		if checkpoint.Signals[i] != want {
			t.Fatalf("Signals[%d] = %q, want %q", i, checkpoint.Signals[i], want)
		}
	}
}

func TestProviderSkipsExistingCheckpointWindow(t *testing.T) {
	now := time.Unix(456, 0).UTC()
	checkpoint, err := New(Config{}).Predict(context.Background(), predictor.RunSnapshot{
		RunID: "run-duplicate",
		Now:   now,
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

	if checkpoint.Status != "skipped" {
		t.Fatalf("Status = %q, want skipped", checkpoint.Status)
	}
	if checkpoint.ObservationWindowS != 300 {
		t.Fatalf("ObservationWindowS = %d, want 300", checkpoint.ObservationWindowS)
	}
	if checkpoint.RiskScore != nil || checkpoint.PredictedPeakRSSMB != nil || checkpoint.PredictedDurationS != nil {
		t.Fatalf("duplicate checkpoint exposed scored fields: %+v", checkpoint)
	}
	if len(checkpoint.Signals) != 0 {
		t.Fatalf("Signals = %v, want none", checkpoint.Signals)
	}
	if !checkpoint.CreatedAt.Equal(now) {
		t.Fatalf("CreatedAt = %v, want %v", checkpoint.CreatedAt, now)
	}
}

func TestProviderReturnsErrorForEmptySnapshot(t *testing.T) {
	_, err := New(Config{}).Predict(context.Background(), predictor.RunSnapshot{}, 30)
	if err == nil {
		t.Fatal("expected error for empty snapshot")
	}
}
