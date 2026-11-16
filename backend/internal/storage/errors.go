package storage

import (
	"errors"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// ErrRunNotFound is returned when a runs/{runID} document does not exist.
var ErrRunNotFound = errors.New("run not found")

// IsNotFound reports whether err is a missing run (typed sentinel or Firestore NotFound).
func IsNotFound(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, ErrRunNotFound) {
		return true
	}
	return status.Code(err) == codes.NotFound
}
