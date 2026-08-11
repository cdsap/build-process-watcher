package relprogress

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/cdsap/build-process-watcher-predictive-provider/internal/provider"
	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
)

// FixtureRun is a private finished-run fixture used for relative-progress study.
type FixtureRun struct {
	RunID          string          `json:"run_id"`
	ProcessCount   int             `json:"process_count"`
	FinalPeakRSSMB float64         `json:"final_peak_rss_mb"`
	FinalDurationS float64         `json:"final_duration_s"`
	AdvisoryRisk   string          `json:"advisory_risk"`
	Samples        []FixtureSample `json:"samples"`
}

// FixtureSample mirrors public telemetry JSON names for private fixture loading.
type FixtureSample struct {
	RunID       string `json:"run_id,omitempty"`
	ElapsedTime int    `json:"elapsed_time"`
	RSS         int    `json:"rss,omitempty"`
	HeapUsed    int    `json:"heap_used,omitempty"`
	HeapCap     int    `json:"heap_cap,omitempty"`
	GCTime      int    `json:"gc_time,omitempty"`
	PID         string `json:"pid,omitempty"`
	Name        string `json:"name,omitempty"`
}

func (s FixtureSample) toPredictorSample(defaultRunID string) predictor.Sample {
	runID := s.RunID
	if runID == "" {
		runID = defaultRunID
	}
	return predictor.Sample{
		RunID:       runID,
		ElapsedTime: s.ElapsedTime,
		RSS:         s.RSS,
		HeapUsed:    s.HeapUsed,
		HeapCap:     s.HeapCap,
		GCTime:      s.GCTime,
		PID:         s.PID,
		Name:        s.Name,
	}
}

type fixtureFile struct {
	Source string       `json:"source"`
	Runs   []FixtureRun `json:"runs"`
}

// LoadFixtureFile reads a private fixture study input.
func LoadFixtureFile(path string) (string, []FixtureRun, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return "", nil, err
	}
	var input fixtureFile
	if err := json.Unmarshal(body, &input); err != nil {
		return "", nil, err
	}
	source := input.Source
	if source == "" {
		source = "fixture"
	}
	return source, input.Runs, nil
}

// RunFixtureStudy compares fixed-window and relative-progress candidates.
func RunFixtureStudy(ctx context.Context, source string, runs []FixtureRun, bar EvidenceBar) (StudyReport, error) {
	if source == "" {
		source = "fixture"
	}
	report := StudyReport{
		Source:      source,
		EvidenceBar: bar,
		Assessments: make([]RunAssessment, 0, len(runs)),
	}
	scorer := provider.New(provider.Config{
		ProviderID:   "relprogress-study",
		ModelVersion: "relprogress-fixture-v1",
	})

	for _, run := range runs {
		snapshot := snapshotForRun(run)
		options := DefaultMapOptions()
		// Use finished duration as the live duration prior so relative mapping
		// can be exercised the same way an earlier predicted_duration_s would.
		options.DurationHintS = run.FinalDurationS
		options.IncludeUnreached = true

		candidates := MapLiveCandidates(snapshot, options)
		scored, err := ScoreCandidates(ctx, scorer, snapshot, candidates)
		if err != nil {
			return StudyReport{}, err
		}

		fixed := make([]ScoredCandidate, 0, len(scored))
		relative := make([]ScoredCandidate, 0, len(scored))
		for _, item := range scored {
			switch item.Candidate.Kind {
			case KindFixed:
				fixed = append(fixed, item)
			case KindRelative:
				relative = append(relative, item)
			}
		}

		assessment := AssessRun(run, fixed, relative)
		report.Assessments = append(report.Assessments, assessment)
		if assessment.LongBuild {
			report.LongBuildRuns++
		} else {
			report.ShortBuildRuns++
		}
		if assessment.UniqueLateSignal {
			report.UniqueLateSignalRuns++
		}
		if assessment.CollisionNoise {
			report.CollisionNoiseRuns++
		}
	}

	return DecideRecommendation(report), nil
}

// RenderMarkdown renders a private advisory study report.
func RenderMarkdown(report StudyReport) (string, error) {
	var buffer bytes.Buffer
	fmt.Fprintf(&buffer, "# Relative-Progress Checkpoint Evaluation\n\n")
	fmt.Fprintf(&buffer, "- Source: %s\n", report.Source)
	fmt.Fprintf(&buffer, "- Fixed windows: `60s`, `5m`, `10m`, `20m`\n")
	fmt.Fprintf(&buffer, "- Relative fractions: `25%%`, `50%%`, `75%%`\n")
	fmt.Fprintf(&buffer, "- Long-build runs: %d\n", report.LongBuildRuns)
	fmt.Fprintf(&buffer, "- Unique late-signal runs: %d\n", report.UniqueLateSignalRuns)
	fmt.Fprintf(&buffer, "- Short-build runs: %d\n", report.ShortBuildRuns)
	fmt.Fprintf(&buffer, "- Collision-noise runs: %d\n", report.CollisionNoiseRuns)
	fmt.Fprintf(&buffer, "- Evidence bar cleared: %t\n", report.EvidenceBarCleared)
	fmt.Fprintf(&buffer, "- Recommendation: `%s`\n", report.Recommendation)
	fmt.Fprintf(&buffer, "- Reason: %s\n\n", report.RecommendationReason)

	fmt.Fprintf(&buffer, "## When relative-progress adds signal\n\n")
	fmt.Fprintf(&buffer, "Relative-progress checkpoints add signal beyond fixed v1 windows when all of the following hold:\n\n")
	fmt.Fprintf(&buffer, "1. Finished duration exceeds the last fixed window (`20m`).\n")
	fmt.Fprintf(&buffer, "2. A relative candidate maps to an `observation_window_s` after `20m` without colliding with a fixed window.\n")
	fmt.Fprintf(&buffer, "3. Scoring that later window raises advisory risk versus the last fixed checkpoint.\n\n")
	fmt.Fprintf(&buffer, "Peak/duration error may also improve at later relative windows, but the private evidence bar counts only late-stage risk lift.\n\n")

	fmt.Fprintf(&buffer, "## Per-run assessments\n\n")
	for _, assessment := range report.Assessments {
		fmt.Fprintf(&buffer, "### %s\n\n", assessment.RunID)
		fmt.Fprintf(&buffer, "- Duration: %.0fs\n", assessment.FinalDurationS)
		fmt.Fprintf(&buffer, "- Long build: %t\n", assessment.LongBuild)
		fmt.Fprintf(&buffer, "- Relative candidates: %d\n", assessment.RelativeCandidateCount)
		fmt.Fprintf(&buffer, "- Unique late signal: %t\n", assessment.UniqueLateSignal)
		fmt.Fprintf(&buffer, "- Risk lift: %.0f\n", assessment.RiskLift)
		if len(assessment.Reasons) > 0 {
			fmt.Fprintf(&buffer, "- Reasons: %s\n", strings.Join(assessment.Reasons, "; "))
		}
		fmt.Fprintln(&buffer)
	}

	text := buffer.String()
	if err := validateAdvisoryLanguage(text); err != nil {
		return "", err
	}
	return text, nil
}

func snapshotForRun(run FixtureRun) predictor.RunSnapshot {
	processInfo := make(map[string]predictor.ProcessInfo, run.ProcessCount)
	for i := 0; i < run.ProcessCount; i++ {
		pid := fmt.Sprintf("%d", i+1)
		processInfo[pid] = predictor.ProcessInfo{PID: pid, Name: "worker"}
	}
	samples := make([]predictor.Sample, 0, len(run.Samples))
	for _, sample := range run.Samples {
		samples = append(samples, sample.toPredictorSample(run.RunID))
	}

	return predictor.RunSnapshot{
		RunID:                 run.RunID,
		Samples:               samples,
		ProcessInfo:           processInfo,
		ExistingCheckpoints:   nil,
		ConfiguredCheckpoints: append([]int(nil), FixedWindows...),
		Now:                   time.Unix(2, 0).UTC(),
	}
}

func validateAdvisoryLanguage(text string) error {
	normalized := strings.ToLower(text)
	for _, phrase := range []string{"guaranteed", "certain failure", "will fail", "will oom", "will time out", "must fail"} {
		if strings.Contains(normalized, phrase) {
			return fmt.Errorf("report contains certainty phrase %q", phrase)
		}
	}
	return nil
}
