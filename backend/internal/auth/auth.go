package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/models"
)

const (
	devJWTSecret   = "build-process-watcher-secret-2024-dev"
	devAdminSecret = "admin-dev-secret-change-me"
)

// Authenticator issues and verifies run JWTs and admin secrets.
// Construct via New / NewFromEnv and inject; do not rely on package globals.
type Authenticator struct {
	jwtKey      []byte
	adminSecret []byte
}

// Config configures Authenticator construction.
type Config struct {
	JWTSecretKey   string
	AdminSecret    string
	RequireSecrets bool // when true, missing secrets are fatal (Cloud Run / prod)
}

// New builds an Authenticator from explicit secrets.
func New(cfg Config) (*Authenticator, error) {
	jwt := strings.TrimSpace(cfg.JWTSecretKey)
	admin := strings.TrimSpace(cfg.AdminSecret)
	if cfg.RequireSecrets {
		if jwt == "" {
			return nil, fmt.Errorf("JWT_SECRET_KEY is required in production")
		}
		if admin == "" {
			return nil, fmt.Errorf("ADMIN_SECRET is required in production")
		}
	}
	if jwt == "" {
		log.Printf("⚠️  WARNING: JWT_SECRET_KEY not set, using insecure development default")
		jwt = devJWTSecret
	}
	if admin == "" {
		log.Printf("⚠️  WARNING: ADMIN_SECRET not set, using insecure development default")
		admin = devAdminSecret
	}
	return &Authenticator{
		jwtKey:      []byte(jwt),
		adminSecret: []byte(admin),
	}, nil
}

// NewFromEnv loads secrets from JWT_SECRET_KEY and ADMIN_SECRET.
// On Cloud Run (K_SERVICE set) missing secrets fail closed.
func NewFromEnv() (*Authenticator, error) {
	return New(Config{
		JWTSecretKey:   os.Getenv("JWT_SECRET_KEY"),
		AdminSecret:    os.Getenv("ADMIN_SECRET"),
		RequireSecrets: strings.TrimSpace(os.Getenv("K_SERVICE")) != "",
	})
}

// NewForTest returns an Authenticator with explicit test secrets.
func NewForTest(jwtSecret, adminSecret string) *Authenticator {
	a, err := New(Config{JWTSecretKey: jwtSecret, AdminSecret: adminSecret})
	if err != nil {
		panic(err)
	}
	return a
}

// RequireAdminAuth checks X-Admin-Secret with a constant-time compare.
func (a *Authenticator) RequireAdminAuth(r *http.Request) bool {
	if a == nil {
		return false
	}
	provided := r.Header.Get("X-Admin-Secret")
	if provided == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(provided), a.adminSecret) == 1
}

// BearerResult is the HTTP-facing outcome of ValidateRunBearer.
// Callers map Status/Message into responses when OK is false.
type BearerResult struct {
	Status  int
	Message string
	OK      bool
}

// ValidateRunBearer verifies Authorization: Bearer <token> for runID.
// Policy (header shape, token checks, public messages, failure logs) lives here
// so HTTP handlers stay adapters. A nil Authenticator is not handled; callers
// must check configuration before invoking.
func (a *Authenticator) ValidateRunBearer(r *http.Request, runID string) BearerResult {
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" {
		log.Printf("No authorization header provided for run_id: %s from %s", runID, r.RemoteAddr)
		return BearerResult{Status: http.StatusUnauthorized, Message: "Authorization header required"}
	}

	tokenParts := strings.Split(authHeader, " ")
	if len(tokenParts) != 2 || tokenParts[0] != "Bearer" {
		log.Printf("Invalid authorization header format for run_id: %s from %s", runID, r.RemoteAddr)
		return BearerResult{Status: http.StatusUnauthorized, Message: "Invalid authorization header format"}
	}

	valid, err := a.ValidateToken(tokenParts[1], runID)
	if err != nil {
		log.Printf("Token validation failed for run_id: %s: %v", runID, err)
		return BearerResult{Status: http.StatusUnauthorized, Message: "Token validation failed"}
	}
	if !valid {
		log.Printf("Invalid token for run_id: %s from %s", runID, r.RemoteAddr)
		return BearerResult{Status: http.StatusUnauthorized, Message: "Invalid token"}
	}
	return BearerResult{OK: true}
}

// GenerateToken generates a JWT-like HMAC token for a specific run.
func (a *Authenticator) GenerateToken(runID string) (string, time.Time, error) {
	if a == nil {
		return "", time.Time{}, fmt.Errorf("authenticator is nil")
	}
	expiresAt := time.Now().Add(2 * time.Hour)
	tokenData := models.TokenData{
		RunID:     runID,
		ExpiresAt: expiresAt,
		CreatedAt: time.Now(),
	}
	payload, err := json.Marshal(tokenData)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("failed to marshal token data: %w", err)
	}
	mac := hmac.New(sha256.New, a.jwtKey)
	mac.Write(payload)
	signature := mac.Sum(nil)
	token := base64.URLEncoding.EncodeToString(payload) + "." + hex.EncodeToString(signature)
	return token, expiresAt, nil
}

// ValidateToken validates a token for a specific run.
func (a *Authenticator) ValidateToken(token string, runID string) (bool, error) {
	if a == nil {
		return false, fmt.Errorf("authenticator is nil")
	}
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return false, fmt.Errorf("invalid token format")
	}
	payload, err := base64.URLEncoding.DecodeString(parts[0])
	if err != nil {
		return false, fmt.Errorf("failed to decode payload: %w", err)
	}
	signature, err := hex.DecodeString(parts[1])
	if err != nil {
		return false, fmt.Errorf("failed to decode signature: %w", err)
	}
	mac := hmac.New(sha256.New, a.jwtKey)
	mac.Write(payload)
	expected := mac.Sum(nil)
	if !hmac.Equal(signature, expected) {
		return false, fmt.Errorf("invalid signature")
	}
	var tokenData models.TokenData
	if err := json.Unmarshal(payload, &tokenData); err != nil {
		return false, fmt.Errorf("failed to unmarshal token data: %w", err)
	}
	if time.Now().After(tokenData.ExpiresAt) {
		return false, fmt.Errorf("token has expired")
	}
	if subtle.ConstantTimeCompare([]byte(tokenData.RunID), []byte(runID)) != 1 {
		return false, fmt.Errorf("token run_id mismatch")
	}
	return true, nil
}
