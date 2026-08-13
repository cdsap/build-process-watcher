package promotion

// CheckpointWindows is the private v1 model lifecycle set.
var CheckpointWindows = []int{60, 300, 600, 1200}

// Evaluation roles distinguish live fixed-window promotion from advisory candidates.
const (
	EvaluationRoleLive     = "live"
	EvaluationRoleAdvisory = "advisory"
)

// QualityReport is the private quality-report input consumed by promotion gates.
// Issue #27 owns report generation; this package only evaluates and promotes.
type QualityReport struct {
	ModelSetVersion  string                  `json:"model_set_version"`
	Checkpoints      []CheckpointQuality     `json:"checkpoints"`
	RelativeProgress RelativeProgressQuality `json:"relative_progress"`
}

// CheckpointQuality summarizes one checkpoint window for promotion decisions.
type CheckpointQuality struct {
	ObservationWindowS       int      `json:"observation_window_s"`
	EvaluationRole           string   `json:"evaluation_role,omitempty"`
	CohortSize               int      `json:"cohort_size"`
	Sparse                   bool     `json:"sparse"`
	PeakRSSMAPE              float64  `json:"peak_rss_mape"`
	DurationMAPE             float64  `json:"duration_mape"`
	RiskAccuracyRate         float64  `json:"risk_accuracy_rate"`
	BaselinePeakRSSMAPE      float64  `json:"baseline_peak_rss_mape"`
	BaselineDurationMAPE     float64  `json:"baseline_duration_mape"`
	BaselineRiskAccuracyRate float64  `json:"baseline_risk_accuracy_rate"`
	CandidateModelVersion    string   `json:"candidate_model_version"`
	Notes                    []string `json:"notes,omitempty"`
}

// RelativeProgressQuality mirrors the advisory relative-progress section of a quality report.
type RelativeProgressQuality struct {
	EvaluationRole           string                     `json:"evaluation_role"`
	LiveFixedWindowsRetained bool                       `json:"live_fixed_windows_retained"`
	CandidateWindows         int                        `json:"candidate_windows"`
	SparseCandidateWindows   int                        `json:"sparse_candidate_windows"`
	ImprovedCandidateWindows int                        `json:"improved_candidate_windows"`
	Candidates               []RelativeCandidateQuality `json:"candidates"`
	Notes                    []string                   `json:"notes,omitempty"`
}

// RelativeCandidateQuality summarizes one advisory relative-progress candidate window.
type RelativeCandidateQuality struct {
	ObservationWindowS       int      `json:"observation_window_s"`
	EvaluationRole           string   `json:"evaluation_role"`
	CohortSize               int      `json:"cohort_size"`
	Sparse                   bool     `json:"sparse"`
	PeakRSSMAPE              float64  `json:"peak_rss_mape"`
	DurationMAPE             float64  `json:"duration_mape"`
	RiskAccuracyRate         float64  `json:"risk_accuracy_rate"`
	BaselinePeakRSSMAPE      float64  `json:"baseline_peak_rss_mape"`
	BaselineDurationMAPE     float64  `json:"baseline_duration_mape"`
	BaselineRiskAccuracyRate float64  `json:"baseline_risk_accuracy_rate"`
	ComparedFixedWindowS     int      `json:"compared_fixed_window_s,omitempty"`
	FixedPeakRSSMAPE         float64  `json:"fixed_peak_rss_mape,omitempty"`
	FixedDurationMAPE        float64  `json:"fixed_duration_mape,omitempty"`
	FixedRiskAccuracyRate    float64  `json:"fixed_risk_accuracy_rate,omitempty"`
	ImprovedVsFixed          bool     `json:"improved_vs_fixed"`
	ImprovedVsBaseline       bool     `json:"improved_vs_baseline"`
	CandidateModelVersion    string   `json:"candidate_model_version"`
	Notes                    []string `json:"notes,omitempty"`
}

// Gate holds private numeric promotion thresholds.
type Gate struct {
	MinCohort           int     `json:"min_cohort"`
	MaxPeakRSSMAPE      float64 `json:"max_peak_rss_mape"`
	MaxDurationMAPE     float64 `json:"max_duration_mape"`
	MinRiskAccuracyRate float64 `json:"min_risk_accuracy_rate"`
}

// DefaultGate returns conservative dry-run gates for local evaluation.
func DefaultGate() Gate {
	return Gate{
		MinCohort:           3,
		MaxPeakRSSMAPE:      0.45,
		MaxDurationMAPE:     0.45,
		MinRiskAccuracyRate: 0.50,
	}
}

// PromotedModel is live-scoring metadata for one independently promoted checkpoint.
type PromotedModel struct {
	ObservationWindowS int    `json:"observation_window_s"`
	ModelVersion       string `json:"model_version"`
	ModelSetVersion    string `json:"model_set_version,omitempty"`
	PromotedAt         string `json:"promoted_at,omitempty"`
}

// Registry is the private promotion state consulted by live scoring.
type Registry struct {
	Models []PromotedModel `json:"models"`
}

// Decision records the refresh outcome for one checkpoint window.
type Decision struct {
	ObservationWindowS int      `json:"observation_window_s"`
	EvaluationRole     string   `json:"evaluation_role,omitempty"`
	Action             string   `json:"action"`
	GateStatus         string   `json:"gate_status"`
	Promoted           bool     `json:"promoted"`
	ModelVersion       string   `json:"model_version,omitempty"`
	PreviousVersion    string   `json:"previous_version,omitempty"`
	CandidateVersion   string   `json:"candidate_version,omitempty"`
	Reasons            []string `json:"reasons,omitempty"`
}

// RelativeProgressReview records advisory candidate evidence without changing live scoring.
type RelativeProgressReview struct {
	EvaluationRole           string                      `json:"evaluation_role"`
	LiveScoringUnchanged     bool                        `json:"live_scoring_unchanged"`
	CandidateWindows         int                         `json:"candidate_windows"`
	SparseCandidateWindows   int                         `json:"sparse_candidate_windows"`
	ImprovedCandidateWindows int                         `json:"improved_candidate_windows"`
	Candidates               []RelativeCandidateEvidence `json:"candidates,omitempty"`
	Notes                    []string                    `json:"notes,omitempty"`
}

// RelativeCandidateEvidence is promotion-review evidence for one advisory candidate.
type RelativeCandidateEvidence struct {
	ObservationWindowS    int      `json:"observation_window_s"`
	EvaluationRole        string   `json:"evaluation_role"`
	CohortSize            int      `json:"cohort_size"`
	Sparse                bool     `json:"sparse"`
	ImprovedVsFixed       bool     `json:"improved_vs_fixed"`
	ImprovedVsBaseline    bool     `json:"improved_vs_baseline"`
	CandidateModelVersion string   `json:"candidate_model_version,omitempty"`
	Notes                 []string `json:"notes,omitempty"`
}

// RefreshResult summarizes one automated refresh and promotion pass.
type RefreshResult struct {
	DryRun                 bool                   `json:"dry_run"`
	ModelSetVersion        string                 `json:"model_set_version"`
	Gate                   Gate                   `json:"gate"`
	Decisions              []Decision             `json:"decisions"`
	Registry               Registry               `json:"registry"`
	RelativeProgressReview RelativeProgressReview `json:"relative_progress_review"`
}
