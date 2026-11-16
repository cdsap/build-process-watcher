package handlers

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/cdsap/build-process-watcher/backend/internal/predictionqueue"
)

func TestHandleCORSPreflightUsesSharedPolicy(t *testing.T) {
	cases := []struct {
		name    string
		methods string
		headers string
	}{
		{name: "get", methods: corsMethodsGET, headers: corsHeadersJSON},
		{name: "post-auth", methods: corsMethodsPOST, headers: corsHeadersAuth},
		{name: "prediction-job", methods: corsMethodsPOST, headers: "Content-Type, " + predictionqueue.JobTokenHeader},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodOptions, "/any", nil)
			if !handleCORSPreflight(recorder, req, tc.methods, tc.headers) {
				t.Fatal("expected OPTIONS to be handled")
			}
			if recorder.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200", recorder.Code)
			}
			if got := recorder.Header().Get("Access-Control-Allow-Origin"); got != "*" {
				t.Fatalf("origin = %q, want *", got)
			}
			if got := recorder.Header().Get("Access-Control-Allow-Methods"); got != tc.methods {
				t.Fatalf("methods = %q, want %q", got, tc.methods)
			}
			if got := recorder.Header().Get("Access-Control-Allow-Headers"); got != tc.headers {
				t.Fatalf("headers = %q, want %q", got, tc.headers)
			}
		})
	}
}

func TestRequireMethodRejectsMismatch(t *testing.T) {
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/ingest", nil)
	if requireMethod(recorder, req, http.MethodPost) {
		t.Fatal("GET should not satisfy POST requirement")
	}
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", recorder.Code)
	}
}

func TestIngestOPTIONSUsesSharedCORS(t *testing.T) {
	h := NewHandlers(newFakeStorage(), nil)
	recorder := httptest.NewRecorder()
	h.Ingest(recorder, httptest.NewRequest(http.MethodOptions, "/ingest", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
	if got := recorder.Header().Get("Access-Control-Allow-Methods"); got != corsMethodsPOST {
		t.Fatalf("methods = %q, want %q", got, corsMethodsPOST)
	}
	if got := recorder.Header().Get("Access-Control-Allow-Headers"); got != corsHeadersAuth {
		t.Fatalf("headers = %q, want %q", got, corsHeadersAuth)
	}
}
