package handlertest

import (
	"net/http"
	"strings"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/auth"
)

// FakeAuthenticator is a handlers.RunAuthenticator double for mux/handler tests.
type FakeAuthenticator struct {
	Token       string
	ExpiresAt   time.Time
	GenerateErr error
	// ValidTokens maps run ID to the token GenerateToken last issued (or seeded).
	ValidTokens map[string]string
	// RejectAll forces ValidateRunBearer to fail when true.
	RejectAll bool
}

// GenerateToken returns Token (or a deterministic fake) for runID.
func (f *FakeAuthenticator) GenerateToken(runID string) (string, time.Time, error) {
	if f.GenerateErr != nil {
		return "", time.Time{}, f.GenerateErr
	}
	token := f.Token
	if token == "" {
		token = "fake-token-" + runID
	}
	if f.ValidTokens == nil {
		f.ValidTokens = make(map[string]string)
	}
	f.ValidTokens[runID] = token
	exp := f.ExpiresAt
	if exp.IsZero() {
		exp = time.Now().Add(2 * time.Hour)
	}
	return token, exp, nil
}

// ValidateRunBearer accepts Authorization: Bearer matching ValidTokens[runID].
func (f *FakeAuthenticator) ValidateRunBearer(r *http.Request, runID string) auth.BearerResult {
	if f.RejectAll {
		return auth.BearerResult{Status: http.StatusUnauthorized, Message: "Invalid token"}
	}
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		return auth.BearerResult{Status: http.StatusUnauthorized, Message: "Authorization header required"}
	}
	parts := strings.Split(authHeader, " ")
	if len(parts) != 2 || parts[0] != "Bearer" {
		return auth.BearerResult{Status: http.StatusUnauthorized, Message: "Invalid authorization header format"}
	}
	want, ok := f.ValidTokens[runID]
	if !ok || want == "" || parts[1] != want {
		return auth.BearerResult{Status: http.StatusUnauthorized, Message: "Invalid token"}
	}
	return auth.BearerResult{OK: true}
}
