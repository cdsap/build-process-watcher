package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestValidateRunBearer(t *testing.T) {
	const runID = "run-bearer-auth-1"
	a := NewForTest("handlers-test-jwt", "handlers-test-admin")

	validToken, _, err := a.GenerateToken(runID)
	if err != nil {
		t.Fatalf("GenerateToken failed: %v", err)
	}
	otherToken, _, err := a.GenerateToken("other-run")
	if err != nil {
		t.Fatalf("GenerateToken for other run failed: %v", err)
	}

	tests := []struct {
		name       string
		header     string
		wantStatus int
		wantMsg    string
		wantOK     bool
	}{
		{
			name:       "missing authorization header",
			header:     "",
			wantStatus: http.StatusUnauthorized,
			wantMsg:    "Authorization header required",
		},
		{
			name:       "invalid authorization header format",
			header:     "Token " + validToken,
			wantStatus: http.StatusUnauthorized,
			wantMsg:    "Invalid authorization header format",
		},
		{
			name:       "invalid token",
			header:     "Bearer not-a-valid-token",
			wantStatus: http.StatusUnauthorized,
			wantMsg:    "Token validation failed",
		},
		{
			name:       "mismatched run id",
			header:     "Bearer " + otherToken,
			wantStatus: http.StatusUnauthorized,
			wantMsg:    "Token validation failed",
		},
		{
			name:   "valid bearer token",
			header: "Bearer " + validToken,
			wantOK: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/ingest", nil)
			if tt.header != "" {
				req.Header.Set("Authorization", tt.header)
			}
			result := a.ValidateRunBearer(req, runID)
			if result.OK != tt.wantOK {
				t.Fatalf("ok = %v, want %v (status=%d message=%q)", result.OK, tt.wantOK, result.Status, result.Message)
			}
			if tt.wantOK {
				if result.Status != 0 || result.Message != "" {
					t.Fatalf("status/message = (%d, %q), want zero values on success", result.Status, result.Message)
				}
				return
			}
			if result.Status != tt.wantStatus {
				t.Fatalf("status = %d, want %d", result.Status, tt.wantStatus)
			}
			if result.Message != tt.wantMsg {
				t.Fatalf("message = %q, want %q", result.Message, tt.wantMsg)
			}
		})
	}
}

func TestAuthenticatorRoundTrip(t *testing.T) {
	a := NewForTest("test-jwt", "test-admin")
	token, expires, err := a.GenerateToken("run-1")
	if err != nil {
		t.Fatal(err)
	}
	if expires.Before(time.Now()) {
		t.Fatal("token already expired")
	}
	ok, err := a.ValidateToken(token, "run-1")
	if err != nil || !ok {
		t.Fatalf("validate: ok=%v err=%v", ok, err)
	}
	ok, err = a.ValidateToken(token, "other-run")
	if ok || err == nil {
		t.Fatal("expected run_id mismatch")
	}
}

func TestRequireAdminAuthConstantTimeMatch(t *testing.T) {
	a := NewForTest("jwt", "super-secret")
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	if a.RequireAdminAuth(req) {
		t.Fatal("missing header should fail")
	}
	req.Header.Set("X-Admin-Secret", "wrong")
	if a.RequireAdminAuth(req) {
		t.Fatal("wrong secret should fail")
	}
	req.Header.Set("X-Admin-Secret", "super-secret")
	if !a.RequireAdminAuth(req) {
		t.Fatal("matching secret should pass")
	}
}

func TestNewRequiresSecretsInProduction(t *testing.T) {
	if _, err := New(Config{RequireSecrets: true}); err == nil {
		t.Fatal("expected error when secrets required and missing")
	}
	if _, err := New(Config{JWTSecretKey: "a", RequireSecrets: true}); err == nil {
		t.Fatal("expected error when admin secret missing")
	}
	a, err := New(Config{JWTSecretKey: "a", AdminSecret: "b", RequireSecrets: true})
	if err != nil || a == nil {
		t.Fatalf("got err=%v a=%v", err, a)
	}
}

func TestNewFallsBackWithWarningOutsideProduction(t *testing.T) {
	a, err := New(Config{})
	if err != nil || a == nil {
		t.Fatalf("dev fallback failed: %v", err)
	}
	token, _, err := a.GenerateToken("run-dev")
	if err != nil {
		t.Fatal(err)
	}
	ok, err := a.ValidateToken(token, "run-dev")
	if !ok || err != nil {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
}
