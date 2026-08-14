package relprogress

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

func TestClassifyRunCoversDurationSparseAndIncomplete(t *testing.T) {
	cases := []struct {
		name       string
		run        FixtureRun
		duration   string
		sparse     bool
		incomplete bool
	}{
		{
			name:     "short",
			run:      FixtureRun{FinalDurationS: 480, Samples: []FixtureSample{{ElapsedTime: 60}, {ElapsedTime: 240}, {ElapsedTime: 480}}},
			duration: CohortShort,
		},
		{
			name:     "medium",
			run:      FixtureRun{FinalDurationS: 900, Samples: []FixtureSample{{ElapsedTime: 60}, {ElapsedTime: 300}, {ElapsedTime: 900}}},
			duration: CohortMedium,
		},
		{
			name:     "long",
			run:      FixtureRun{FinalDurationS: 3600, Samples: []FixtureSample{{ElapsedTime: 60}, {ElapsedTime: 1200}, {ElapsedTime: 2400}, {ElapsedTime: 3600}}},
			duration: CohortLong,
		},
		{
			name:       "sparse long",
			run:        FixtureRun{FinalDurationS: 3200, Samples: []FixtureSample{{ElapsedTime: 60}, {ElapsedTime: 1600}, {ElapsedTime: 3200}}},
			duration:   CohortLong,
			sparse:     true,
			incomplete: false,
		},
		{
			name:       "incomplete long",
			run:        FixtureRun{FinalDurationS: 3600, Samples: []FixtureSample{{ElapsedTime: 60}, {ElapsedTime: 300}, {ElapsedTime: 600}, {ElapsedTime: 900}}},
			duration:   CohortLong,
			incomplete: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			duration, sparse, incomplete := ClassifyRun(tc.run)
			if duration != tc.duration || sparse != tc.sparse || incomplete != tc.incomplete {
				t.Fatalf("ClassifyRun = (%s,%t,%t), want (%s,%t,%t)", duration, sparse, incomplete, tc.duration, tc.sparse, tc.incomplete)
			}
		})
	}
}

func TestHistoricalCorpusStudyClearsEvidenceBarAndReportsCohorts(t *testing.T) {
	path := filepath.Join("testdata", "corpus_runs.json")
	source, runs, err := LoadFixtureFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if source != "historical" {
		t.Fatalf("source = %q, want historical", source)
	}
	if !IsHistoricalCorpusSource(source) {
		t.Fatal("historical source must clear fixture-only corpus requirement")
	}

	report, err := RunFixtureStudy(context.Background(), source, runs, DefaultEvidenceBar())
	if err != nil {
		t.Fatal(err)
	}
	if report.ShortBuildRuns < 1 || report.MediumBuildRuns < 1 || report.LongBuildRuns < 3 {
		t.Fatalf("cohort counts short=%d medium=%d long=%d", report.ShortBuildRuns, report.MediumBuildRuns, report.LongBuildRuns)
	}
	if report.SparseDataRuns < 1 {
		t.Fatalf("SparseDataRuns = %d, want >= 1", report.SparseDataRuns)
	}
	if report.IncompleteRuns < 1 {
		t.Fatalf("IncompleteRuns = %d, want >= 1", report.IncompleteRuns)
	}
	if report.UniqueLateSignalRuns < 2 {
		t.Fatalf("UniqueLateSignalRuns = %d, want >= 2", report.UniqueLateSignalRuns)
	}
	if !report.RelativeImprovesOverFixed {
		t.Fatalf("RelativeImprovesOverFixed = false, reason = %q", report.ImprovementReason)
	}
	if !report.EvidenceBarCleared {
		t.Fatalf("historical corpus should clear evidence bar, reason = %q", report.RecommendationReason)
	}
	if report.Recommendation != RecommendationShip {
		t.Fatalf("Recommendation = %q, want ship", report.Recommendation)
	}

	byName := map[string]CohortMetrics{}
	for _, cohort := range report.Cohorts {
		byName[cohort.Name] = cohort
	}
	for _, name := range CohortNames() {
		cohort, ok := byName[name]
		if !ok {
			t.Fatalf("missing cohort %s", name)
		}
		if cohort.RunCount < 1 {
			t.Fatalf("cohort %s run count = %d", name, cohort.RunCount)
		}
	}
	if byName[CohortSparse].SparseDataCases < 1 {
		t.Fatalf("sparse cohort sparse-data cases = %d", byName[CohortSparse].SparseDataCases)
	}
	if byName[CohortIncomplete].IncompleteCases < 1 {
		t.Fatalf("incomplete cohort incomplete cases = %d", byName[CohortIncomplete].IncompleteCases)
	}

	markdown, err := RenderMarkdown(report)
	if err != nil {
		t.Fatal(err)
	}
	for _, needle := range []string{
		"Source: historical",
		"Relative improves over fixed windows: true",
		"Recommendation: `ship`",
		"## Cohort summary",
		"### short",
		"### medium",
		"### long",
		"### sparse",
		"### incomplete",
		"Fixed risk-class accuracy:",
		"Relative risk-class accuracy:",
		"Sparse-data cases:",
		"corpus-incomplete-long-1",
		"corpus-sparse-long-1",
	} {
		if !strings.Contains(markdown, needle) {
			t.Fatalf("corpus report missing %q:\n%s", needle, markdown)
		}
	}
	lower := strings.ToLower(markdown)
	for _, banned := range []string{"feature formula", "training corpus", "customer", "gs://", "testdata/corpus_runs.json"} {
		if strings.Contains(lower, banned) {
			t.Fatalf("corpus report leaked private detail %q:\n%s", banned, markdown)
		}
	}
}

func TestDecideRecommendationShipsHistoricalCorpusWithSignal(t *testing.T) {
	report := DecideRecommendation(StudyReport{
		Source:               "historical",
		EvidenceBar:          DefaultEvidenceBar(),
		LongBuildRuns:        3,
		UniqueLateSignalRuns: 2,
		ShortBuildRuns:       1,
		MediumBuildRuns:      1,
	})
	if !report.EvidenceBarCleared || report.Recommendation != RecommendationShip {
		t.Fatalf("historical decision = %+v", report)
	}
}
