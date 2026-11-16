package handlertest

import (
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/auth"
)

// FakeRunAuthenticator is an in-memory handlers.RunAuthenticator for tests.
// It does not perform HMAC; GenerateToken stores a deterministic token per run.
type FakeRunAuthenticator struct {
	mu          sync.Mutex
	tokens      map[string]string
	GenerateErr error
	RejectAll   bool
}

// NewFakeRunAuthenticator returns an empty FakeRunAuthenticator.
func NewFakeRunAuthenticator() *FakeRunAuthenticator {
	return &FakeRunAuthenticator{tokens: make(map[string]string)}
}

// GenerateToken records and returns a fake bearer token for runID.
func (f *FakeRunAuthenticator) GenerateToken(runID string) (string, time.Time, error) {
	if f == nil {
		return "", time.Time{}, fmt.Errorf("authenticator is nil")
	}
	if f.GenerateErr != nil {
		return "", time.Time{}, f.GenerateErr
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.tokens == nil {
		f.tokens = make(map[string]string)
	}
	token := "fake-token-" + runID
	f.tokens[runID] = token
	return token, time.Now().UTC().Add(2 * time.Hour), nil
}

// ValidateRunBearer accepts Bearer tokens previously issued by GenerateToken.
func (f *FakeRunAuthenticator) ValidateRunBearer(r *http.Request, runID string) auth.BearerResult {
	if f == nil || f.RejectAll {
		return auth.BearerResult{Status: http.StatusUnauthorized, Message: "Invalid token"}
	}
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		return auth.BearerResult{Status: http.StatusUnauthorized, Message: "Authorization header required"}
	}
	parts := strings.SplitN(authHeader, " ", 2)
	if len(parts) != 2 || parts[0] != "Bearer" {
		return auth.BearerResult{Status: http.StatusUnauthorized, Message: "Invalid authorization header format"}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	expected, ok := f.tokens[runID]
	if !ok || parts[1] != expected {
		return auth.BearerResult{Status: http.StatusUnauthorized, Message: "Invalid token"}
	}
	return auth.BearerResult{OK: true}
}
