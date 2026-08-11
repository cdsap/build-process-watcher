package quality

// CheckpointWindows is the private v1 checkpoint lifecycle set.
var CheckpointWindows = []int{60, 300, 600, 1200}

// Dataset is the private finished-run evaluation input used to generate quality reports.
// It must not include customer metadata, feature formulas, or training corpus details.
type Dataset struct {
	ModelSetVersion string        `json:"model_set_version"`
	MinCohort       int           `json:"min_cohort,omitempty"`
	Runs            []FinishedRun `json:"runs"`
}

// FinishedRun is one finished evaluation unit with checkpoint predictions and outcomes.
type FinishedRun struct {
	Checkpoints []CheckpointObservation `json:"checkpoints"`
}

// CheckpointObservation holds model, baseline, and actual values for one window.
type CheckpointObservation struct {
	ObservationWindowS    int     `json:"observation_window_s"`
	PredictedPeakRSSMB    float64 `json:"predicted_peak_rss_mb"`
	PredictedDurationS    float64 `json:"predicted_duration_s"`
	PredictedRisk         string  `json:"predicted_risk"`
	BaselinePeakRSSMB     float64 `json:"baseline_peak_rss_mb"`
	BaselineDurationS     float64 `json:"baseline_duration_s"`
	BaselineRisk          string  `json:"baseline_risk"`
	ActualPeakRSSMB       float64 `json:"actual_peak_rss_mb"`
	ActualDurationS       float64 `json:"actual_duration_s"`
	ActualRisk            string  `json:"actual_risk"`
	CandidateModelVersion string  `json:"candidate_model_version,omitempty"`
}

// Report is the private quality-report artifact consumed by promotion gates.
// The JSON shape matches the promotion package QualityReport contract.
type Report struct {
	ModelSetVersion string              `json:"model_set_version"`
	Checkpoints     []CheckpointQuality `json:"checkpoints"`
}

// CheckpointQuality summarizes prediction and risk-class quality for one window.
type CheckpointQuality struct {
	ObservationWindowS       int      `json:"observation_window_s"`
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
