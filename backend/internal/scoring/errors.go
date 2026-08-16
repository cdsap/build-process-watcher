package scoring

import "errors"

var (
	ErrNoData           = errors.New("prediction scoring no data")
	ErrScoringTimeout   = errors.New("prediction scoring timeout")
	ErrScoringFailed    = errors.New("prediction scoring failed")
	ErrModelUnavailable = errors.New("prediction model unavailable")
)
