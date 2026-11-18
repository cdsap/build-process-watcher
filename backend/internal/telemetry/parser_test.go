package telemetry

import (
	"bytes"
	"encoding/json"
	"log"
	"strings"
	"testing"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/models"
)

func TestParseDataHistoricalAndExtendedRecords(t *testing.T) {
	start := time.Unix(100, 0)
	data := "00:00:01 | 1 | Old | 10MB | 20MB | 30MB\n" +
		"00:00:02 | 2 | Extended | 11MB | 21MB | 31MB | 0.125s | 40 | 1 | 2 | 0.456 | 900 | 12 | 0.789"

	samples, err := ParseData(data, start)
	if err != nil {
		t.Fatal(err)
	}
	if len(samples) != 2 {
		t.Fatalf("expected 2 samples, got %d", len(samples))
	}
	if samples[0].JITCompiledMethods != nil {
		t.Fatal("historical sample should have nil optional metrics")
	}
	extended := samples[1]
	assertIntPointer(t, "compiled", extended.JITCompiledMethods, 40)
	assertIntPointer(t, "jit time", extended.JITCompilationTimeMs, 456)
	assertIntPointer(t, "loaded", extended.ClassesLoaded, 900)
	assertIntPointer(t, "class time", extended.ClassLoadTimeMs, 789)
}

func TestParseDataAcceptsLegacyMillisecondGC(t *testing.T) {
	samples, err := ParseData("00:00:01 | 1 | Proc | 10MB | 20MB | 30MB | 234ms", time.Unix(0, 0))
	if err != nil || len(samples) != 1 {
		t.Fatalf("unexpected parse result: %v, %d samples", err, len(samples))
	}
	if samples[0].GCTime != 234 {
		t.Fatalf("expected 234ms, got %d", samples[0].GCTime)
	}
}

func TestParseDataDoesNotLogRawPayload(t *testing.T) {
	var buf bytes.Buffer
	prev := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(prev)

	secretLine := "00:00:01 | 42 | GradleDaemon | 10MB | 20MB | 30MB | 0.1s"
	samples, err := ParseData(secretLine, time.Unix(0, 0))
	if err != nil {
		t.Fatal(err)
	}
	if len(samples) != 1 {
		t.Fatalf("expected 1 sample, got %d", len(samples))
	}
	logged := buf.String()
	for _, forbidden := range []string{
		"Raw data:",
		"PARSING DATA",
		"Created sample:",
		"Processing line",
		secretLine,
		"GradleDaemon",
	} {
		if strings.Contains(logged, forbidden) {
			t.Fatalf("ParseData logged sensitive/verbose payload marker %q in %q", forbidden, logged)
		}
	}
}

func TestParseDataMalformedOptionalMetricDoesNotDiscardSample(t *testing.T) {
	samples, err := ParseData("00:00:01 | 1 | Proc | 10MB | 20MB | 30MB | N/A | bad | N/A | 2 | N/A | 0 | N/A | broken", time.Unix(0, 0))
	if err != nil {
		t.Fatal(err)
	}
	if len(samples) != 1 {
		t.Fatalf("expected base sample to survive, got %d samples", len(samples))
	}
	if samples[0].JITCompiledMethods != nil || samples[0].ClassLoadTimeMs != nil {
		t.Fatal("malformed optional values should be nil")
	}
	assertIntPointer(t, "invalidated", samples[0].JITInvalidatedCompilations, 2)
	assertIntPointer(t, "loaded zero", samples[0].ClassesLoaded, 0)
}

func TestParseDataFieldWidthTable(t *testing.T) {
	start := time.Unix(50, 0)
	cases := []struct {
		name    string
		line    string
		wantLen int
		check   func(t *testing.T, sample models.Sample)
	}{
		{
			name:    "6-field historical",
			line:    "00:00:01 | 1 | Proc | 10MB | 20MB | 30MB",
			wantLen: 1,
			check: func(t *testing.T, sample models.Sample) {
				if sample.GCTime != 0 || sample.JITCompiledMethods != nil {
					t.Fatal("6-field sample should omit GC and optional metrics")
				}
			},
		},
		{
			name:    "7-field with GC seconds",
			line:    "00:00:02 | 1 | Proc | 10MB | 20MB | 30MB | 0.5s",
			wantLen: 1,
			check: func(t *testing.T, sample models.Sample) {
				if sample.GCTime != 500 {
					t.Fatalf("GCTime = %d, want 500", sample.GCTime)
				}
			},
		},
		{
			name:    "14-field extended",
			line:    "00:00:03 | 9 | Kotlin | 1.5MB | 2.5MB | 3.5MB | 1s | 10 | 0 | 1 | 0.2 | 50 | 3 | 0.1",
			wantLen: 1,
			check: func(t *testing.T, sample models.Sample) {
				if sample.HeapUsed != 1 || sample.HeapCap != 2 || sample.RSS != 3 {
					t.Fatalf("MB float truncation failed: %+v", sample)
				}
				assertIntPointer(t, "compiled", sample.JITCompiledMethods, 10)
				assertIntPointer(t, "class time", sample.ClassLoadTimeMs, 100)
			},
		},
		{
			name:    "unsupported width skipped",
			line:    "00:00:01 | 1 | Proc | 10MB",
			wantLen: 0,
		},
		{
			name:    "blank lines ignored",
			line:    "\n\n00:00:01 | 1 | Proc | 10MB | 20MB | 30MB\n\n",
			wantLen: 1,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			samples, err := ParseData(tc.line, start)
			if err != nil {
				t.Fatal(err)
			}
			if len(samples) != tc.wantLen {
				t.Fatalf("len = %d, want %d", len(samples), tc.wantLen)
			}
			if tc.check != nil && len(samples) > 0 {
				tc.check(t, samples[0])
			}
		})
	}
}

func TestSampleJSONRoundTripOptionalMetrics(t *testing.T) {
	samples, _ := ParseData("00:00:01 | 1 | Proc | 10MB | 20MB | 30MB | 0s | 5 | N/A | N/A | 0.25 | 100 | N/A | N/A", time.Unix(0, 0))
	encoded, err := json.Marshal(samples[0])
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]interface{}
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["JITCompiledMethods"] != float64(5) || decoded["JITFailedCompilations"] != nil {
		t.Fatalf("unexpected JSON: %s", encoded)
	}
}

func assertIntPointer(t *testing.T, name string, value *int, expected int) {
	t.Helper()
	if value == nil || *value != expected {
		t.Fatalf("%s: expected %d, got %v", name, expected, value)
	}
}
