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
			{ElapsedTime: 10, RSS: 512 * 1024},
			{ElapsedTime: 60, RSS: 768 * 1024},
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
}

func TestProviderReturnsElevatedMemorySignal(t *testing.T) {
	checkpoint, err := New(Config{}).Predict(context.Background(), predictor.RunSnapshot{
		Samples: []predictor.Sample{{ElapsedTime: 60, RSS: 3 * 1024 * 1024}},
	}, 60)
	if err != nil {
		t.Fatal(err)
	}

	if checkpoint.RiskLevel != "elevated" {
		t.Fatalf("RiskLevel = %q, want elevated", checkpoint.RiskLevel)
	}
	if checkpoint.Confidence != "medium" {
		t.Fatalf("Confidence = %q, want medium", checkpoint.Confidence)
	}
	if len(checkpoint.Signals) != 1 || checkpoint.Signals[0] != "memory pressure" {
		t.Fatalf("Signals = %v, want [memory pressure]", checkpoint.Signals)
	}
}

func TestProviderReturnsErrorForEmptySnapshot(t *testing.T) {
	_, err := New(Config{}).Predict(context.Background(), predictor.RunSnapshot{}, 30)
	if err == nil {
		t.Fatal("expected error for empty snapshot")
	}
}
