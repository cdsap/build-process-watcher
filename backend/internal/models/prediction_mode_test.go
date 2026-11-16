package models

import "testing"

func TestParsePredictionMode(t *testing.T) {
	tests := []struct {
		raw  string
		want PredictionMode
		ok   bool
	}{
		{raw: "", want: "", ok: true},
		{raw: " disabled ", want: PredictionModeDisabled, ok: true},
		{raw: "reliability", want: PredictionModeReliability, ok: true},
		{raw: "forecast", want: PredictionModeForecast, ok: true},
		{raw: "predict", want: PredictionModePredict, ok: true},
		{raw: "bqml-boosted", want: PredictionModeBQMLBoosted, ok: true},
		{raw: "unknown", ok: false},
	}
	for _, tt := range tests {
		got, ok := ParsePredictionMode(tt.raw)
		if ok != tt.ok || got != tt.want {
			t.Fatalf("ParsePredictionMode(%q) = (%q, %t), want (%q, %t)", tt.raw, got, ok, tt.want, tt.ok)
		}
	}
}

func TestPredictionModeIsTimeline(t *testing.T) {
	if PredictionModeReliability.IsTimeline() {
		t.Fatal("reliability should not be timeline")
	}
	for _, mode := range []PredictionMode{PredictionModeForecast, PredictionModePredict, PredictionModeBQMLBoosted} {
		if !mode.IsTimeline() {
			t.Fatalf("%q should be timeline", mode)
		}
	}
}

func TestThrottleElapsedSeconds(t *testing.T) {
	if ThrottleElapsedSeconds != 20 {
		t.Fatalf("ThrottleElapsedSeconds = %d, want 20", ThrottleElapsedSeconds)
	}
}
