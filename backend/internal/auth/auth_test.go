package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

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
