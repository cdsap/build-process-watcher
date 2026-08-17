package scoring

import "errors"

var (
	ErrNoData           = errors.New("prediction scoring no data")
	ErrScoringTimeout   = errors.New("prediction scoring timeout")
	ErrScoringFailed    = errors.New("prediction scoring failed")
	ErrModelUnavailable = errors.New("prediction model unavailable")
)

// State is the public-safe telemetry category recorded for a scoring fallback.
type State string

const (
	StateNoData           State = "no_data"
	StateModelUnavailable State = "model_unavailable"
	StateProviderError    State = "provider_error"
)

// ClassifyFallback maps scoring sentinel errors onto telemetry state and the
// matching public-safe checkpoint message. Unknown errors become provider_error.
func ClassifyFallback(err error) (state State, message string) {
	switch {
	case errors.Is(err, ErrNoData):
		return StateNoData, "prediction data unavailable"
	case errors.Is(err, ErrModelUnavailable):
		return StateModelUnavailable, "prediction model unavailable"
	case errors.Is(err, ErrScoringTimeout), errors.Is(err, ErrScoringFailed):
		return StateProviderError, "prediction provider error"
	default:
		return StateProviderError, "prediction provider error"
	}
}
