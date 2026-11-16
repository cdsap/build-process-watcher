package handlers

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/auth"
	"github.com/cdsap/build-process-watcher/backend/internal/models"
)

// validateRunBearerToken verifies the Authorization Bearer token for a run write.
// Callers write the HTTP response using the returned status and message when ok is false.
func validateRunBearerToken(r *http.Request, runID string) (status int, message string, ok bool) {
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		log.Printf("No authorization header provided for run_id: %s from %s", runID, r.RemoteAddr)
		return http.StatusUnauthorized, "Authorization header required", false
	}

	tokenParts := strings.Split(authHeader, " ")
	if len(tokenParts) != 2 || tokenParts[0] != "Bearer" {
		log.Printf("Invalid authorization header format for run_id: %s from %s", runID, r.RemoteAddr)
		return http.StatusUnauthorized, "Invalid authorization header format", false
	}

	token := tokenParts[1]
	valid, err := auth.ValidateToken(token, runID)
	if err != nil {
		log.Printf("Token validation failed for run_id: %s: %v", runID, err)
		return http.StatusUnauthorized, "Token validation failed", false
	}

	if !valid {
		log.Printf("Invalid token for run_id: %s from %s", runID, r.RemoteAddr)
		return http.StatusUnauthorized, "Invalid token", false
	}

	return 0, "", true
}

// Auth generates a JWT token for a run
func (h *Handlers) Auth(w http.ResponseWriter, r *http.Request) {
	runID := strings.TrimPrefix(r.URL.Path, "/auth/run/")
	if runID == "" {
		http.Error(w, "run_id is required", http.StatusBadRequest)
		return
	}

	mode, ok := models.ParsePredictionMode(r.URL.Query().Get("prediction_mode"))
	if !ok {
		http.Error(w, "invalid prediction_mode", http.StatusBadRequest)
		return
	}
	legacy := boolQuery(r, "predictive_reliability")
	if legacy && mode != models.PredictionModeUnset && mode != models.PredictionModeReliability {
		http.Error(w, "conflicting prediction settings", http.StatusBadRequest)
		return
	}
	if mode == models.PredictionModeUnset && legacy {
		mode = models.PredictionModeReliability
	}
	if h.storage != nil && mode != models.PredictionModeUnset && mode != models.PredictionModeDisabled {
		if err := h.storage.SetRunPredictionMode(r.Context(), runID, mode.String()); err != nil {
			log.Printf("Warning: could not persist prediction mode for run %s: %v", runID, err)
		}
	}
	if h.storage != nil && r.URL.Query().Get("export_to_bigquery") == "true" {
		if err := h.storage.SetRunExportToBigquery(r.Context(), runID, true); err != nil {
			log.Printf("Warning: could not persist export_to_bigquery for run %s: %v", runID, err)
		}
	}
	if h.storage != nil && mode == models.PredictionModeReliability {
		if err := h.storage.SetRunPredictiveReliability(r.Context(), runID, true); err != nil {
			log.Printf("Warning: could not persist predictive_reliability for run %s: %v", runID, err)
		}
	}

	log.Printf("🔐 Auth request for run_id: %s", runID)

	token, expiresAt, err := auth.GenerateToken(runID)
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

func boolQuery(r *http.Request, key string) bool {
	enabled, err := strconv.ParseBool(strings.TrimSpace(r.URL.Query().Get(key)))
	return err == nil && enabled
}
