package handlers

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/models"
)

// validateRunBearerToken adapts auth.ValidateRunBearer for HTTP handlers.
// Callers write the HTTP response using the returned status and message when ok is false.
func (h *Handlers) validateRunBearerToken(r *http.Request, runID string) (status int, message string, ok bool) {
	if h == nil || h.authn == nil {
		log.Printf("Authenticator not configured for run_id: %s", runID)
		return http.StatusInternalServerError, "Authenticator not configured", false
	}
	result := h.authn.ValidateRunBearer(r, runID)
	return result.Status, result.Message, result.OK
}

// Auth generates a JWT token for a run
func (h *Handlers) Auth(w http.ResponseWriter, r *http.Request) {
	runID := strings.TrimPrefix(r.URL.Path, "/auth/run/")
	if runID == "" {
		http.Error(w, "run_id is required", http.StatusBadRequest)
		return
	}

	opts, err := parseAuthRunOptions(r.URL.Query())
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := h.applyAuthRunOptions(r.Context(), runID, opts); err != nil {
		log.Printf("Failed to persist run options: %v", err)
		http.Error(w, "Failed to configure run", http.StatusInternalServerError)
		return
	}

	log.Printf("🔐 Auth request for run_id: %s", runID)

	if h.authn == nil {
		http.Error(w, "Authenticator not configured", http.StatusInternalServerError)
		return
	}
	token, expiresAt, err := h.authn.GenerateToken(runID)
	if err != nil {
		log.Printf("Failed to generate token: %v", err)
		http.Error(w, "Failed to generate token", http.StatusInternalServerError)
		return
	}

	response := models.TokenResponse{
		Token:     token,
		ExpiresAt: expiresAt,
	}

	w.Header().Set("Content-Type", "application/json")
	setCORSHeaders(w, "", "")
	json.NewEncoder(w).Encode(response)

	log.Printf("✅ Generated token for run_id: %s, expires at: %s", runID, expiresAt.Format(time.RFC3339))
}
