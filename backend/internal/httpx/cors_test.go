package httpx

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHandleCORSPreflight(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodOptions, "/cleanup/stale", nil)
	if !HandleCORSPreflight(rec, req, MethodsPOST, HeadersAdmin) {
		t.Fatal("expected preflight to be handled")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Headers"); got != HeadersAdmin {
		t.Fatalf("headers=%q, want %q", got, HeadersAdmin)
	}
	if got := rec.Header().Get("Access-Control-Allow-Methods"); got != MethodsPOST {
		t.Fatalf("methods=%q, want %q", got, MethodsPOST)
	}
}

func TestRequireMethod(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/cleanup/stale", nil)
	if RequireMethod(rec, req, http.MethodPost) {
		t.Fatal("GET should fail POST requirement")
	}
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status=%d", rec.Code)
	}
}
