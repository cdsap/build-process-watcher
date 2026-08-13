package quality

// PredictionDataset is an exported sample of private prediction attempts used to
// generate the recurring prediction-quality health report. It must not include
// customer metadata, feature formulas, thresholds, or training corpus details.
type PredictionDataset struct {
	// Period is an opaque private label for the reporting window (for example a fixture id).
	Period      string              `json:"period,omitempty"`
	Predictions []PredictionRecord  `json:"predictions"`
}

// PredictionRecord is one private prediction attempt or finished-run labeled outcome.
type PredictionRecord struct {
	ObservationWindowS int    `json:"observation_window_s"`
	PredictedRisk      string `json:"predicted_risk,omitempty"`
	Outcome            string `json:"outcome,omitempty"`
	State              string `json:"state,omitempty"`
	// IncompleteFeatures marks partial/missing derived feature rows for ops triage.
	IncompleteFeatures bool `json:"incomplete_features,omitempty"`

	// Optional outcome labels. When present, calibration and outcome-quality signals are computed.
	ActualRisk         string   `json:"actual_risk,omitempty"`
	PredictedPeakRSSMB *float64 `json:"predicted_peak_rss_mb,omitempty"`
	PredictedDurationS *float64 `json:"predicted_duration_s,omitempty"`
	ActualPeakRSSMB    *float64 `json:"actual_peak_rss_mb,omitempty"`
	ActualDurationS    *float64 `json:"actual_duration_s,omitempty"`
}

// PredictionReport is the private recurring prediction-quality artifact for ops review.
type PredictionReport struct {
	Period      string                     `json:"period,omitempty"`
	Checkpoints []WindowPredictionQuality  `json:"checkpoints"`
}

// WindowPredictionQuality summarizes production prediction health for one checkpoint window.
type WindowPredictionQuality struct {
	ObservationWindowS int `json:"observation_window_s"`
	PredictionVolume   int `json:"prediction_volume"`

	RiskLow       int `json:"risk_low"`
	RiskElevated  int `json:"risk_elevated"`
	RiskHigh      int `json:"risk_high"`
	RiskUnknown   int `json:"risk_unknown"`
	RiskMissing   int `json:"risk_missing"`

	OutcomeSuccess  int `json:"outcome_success"`
	OutcomeSkipped  int `json:"outcome_skipped"`
	OutcomeTimeout  int `json:"outcome_timeout"`
	OutcomeError    int `json:"outcome_error"`
	OutcomeFallback int `json:"outcome_fallback"`
	OutcomeMissing  int `json:"outcome_missing"`
	OutcomeUnknown  int `json:"outcome_unknown"`

	StateNoData           int `json:"state_no_data"`
	StatePartialData      int `json:"state_partial_data"`
	StateProviderError    int `json:"state_provider_error"`
	StateModelUnavailable int `json:"state_model_unavailable"`

	IncompleteFeatureRecords int `json:"incomplete_feature_records"`
	ProviderErrors           int `json:"provider_errors"`
	FallbackUsage            int `json:"fallback_usage"`

	LabeledOutcomes      int      `json:"labeled_outcomes"`
	RiskAccuracyRate     float64  `json:"risk_accuracy_rate,omitempty"`
	PeakRSSMAPE          float64  `json:"peak_rss_mape,omitempty"`
	DurationMAPE         float64  `json:"duration_mape,omitempty"`
	CalibrationAvailable bool     `json:"calibration_available"`
	Notes                []string `json:"notes,omitempty"`
}
