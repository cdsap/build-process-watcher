package cleanup

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/cdsap/build-process-watcher/backend/internal/runlifecycle"
)

type fakeAuth struct {
	ok bool
}

func (f fakeAuth) RequireAdminAuth(*http.Request) bool { return f.ok }

type fakeLifecycle struct {
	result runlifecycle.StaleCleanupResult
	err    error
	calls  int
}

func (f *fakeLifecycle) FinishAllStale(context.Context) (runlifecycle.StaleCleanupResult, error) {
	f.calls++
	return f.result, f.err
}

func TestHandleManualStaleCleanupRequiresAdmin(t *testing.T) {
	svc := New(&fakeLifecycle{}, fakeAuth{ok: false})
	rec := httptest.NewRecorder()
	svc.HandleManualStaleCleanup(rec, httptest.NewRequest(http.MethodPost, "/cleanup/stale", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d, want 401", rec.Code)
	}
}

func TestHandleManualStaleCleanupOptions(t *testing.T) {
	svc := New(nil, nil)
	rec := httptest.NewRecorder()
	svc.HandleManualStaleCleanup(rec, httptest.NewRequest(http.MethodOptions, "/cleanup/stale", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d, want 200", rec.Code)
	}
}

func TestHandleManualStaleCleanupMethodNotAllowed(t *testing.T) {
	svc := New(&fakeLifecycle{}, fakeAuth{ok: true})
	rec := httptest.NewRecorder()
	svc.HandleManualStaleCleanup(rec, httptest.NewRequest(http.MethodGet, "/cleanup/stale", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status=%d, want 405", rec.Code)
	}
}

func TestHandleManualStaleCleanupUnconfiguredLifecycle(t *testing.T) {
	svc := New(nil, fakeAuth{ok: true})
	rec := httptest.NewRecorder()
	svc.HandleManualStaleCleanup(rec, httptest.NewRequest(http.MethodPost, "/cleanup/stale", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d, want 500", rec.Code)
	}
}

func TestHandleManualStaleCleanupEmptySuccess(t *testing.T) {
	life := &fakeLifecycle{result: runlifecycle.StaleCleanupResult{}}
	svc := New(life, fakeAuth{ok: true})
	rec := httptest.NewRecorder()
	svc.HandleManualStaleCleanup(rec, httptest.NewRequest(http.MethodPost, "/cleanup/stale", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["stale_found"] != float64(0) || body["cleaned_up"] != float64(0) {
		t.Fatalf("unexpected body: %#v", body)
	}
	if life.calls != 1 {
		t.Fatalf("calls=%d", life.calls)
	}
}

func TestHandleManualStaleCleanupPartialSuccess(t *testing.T) {
	life := &fakeLifecycle{result: runlifecycle.StaleCleanupResult{
		StaleFound: []string{"a", "b"},
		Cleaned:    []string{"a"},
	}}
	svc := New(life, fakeAuth{ok: true})
	rec := httptest.NewRecorder()
	svc.HandleManualStaleCleanup(rec, httptest.NewRequest(http.MethodPost, "/cleanup/stale", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["stale_found"] != float64(2) || body["cleaned_up"] != float64(1) {
		t.Fatalf("unexpected body: %#v", body)
	}
}

func TestHandleManualStaleCleanupFinderError(t *testing.T) {
	life := &fakeLifecycle{err: errors.New("finder boom")}
	svc := New(life, fakeAuth{ok: true})
	rec := httptest.NewRecorder()
	svc.HandleManualStaleCleanup(rec, httptest.NewRequest(http.MethodPost, "/cleanup/stale", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}
