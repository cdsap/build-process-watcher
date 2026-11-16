package main

import (
	"net/http"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/auth"
	"github.com/cdsap/build-process-watcher/backend/internal/cleanup"
	"github.com/cdsap/build-process-watcher/backend/internal/handlers"
	"github.com/cdsap/build-process-watcher/backend/internal/models"
	"github.com/cdsap/build-process-watcher/backend/internal/storage"
)

// Re-export types and functions for tests

// Types
type Sample = models.Sample
type RunDoc = models.RunDoc
type RunResponse = models.RunResponse
type TokenRequest = models.TokenRequest
type TokenResponse = models.TokenResponse
type TokenData = models.TokenData

// Storage functions
var toMillis = storage.ToMillis

// Variables for tests
var (
	buildTimeout        = 5 * time.Minute
	dataRetentionPeriod = 3 * time.Hour
	firestoreClient     interface{} // Placeholder for tests
)

// Global test handlers
var (
	testAuth           *auth.Authenticator
	testHandlers       *handlers.Handlers
	testCleanupService *cleanup.Service
)

func init() {
	testAuth = auth.NewForTest("build-process-watcher-secret-2024-dev", "admin-dev-secret-change-me")
	testHandlers = handlers.NewHandlers(nil, nil)
	testHandlers.SetAuthenticator(testAuth)
	testCleanupService = cleanup.NewService(nil, nil, testAuth)
}

func generateToken(runID string) (string, time.Time, error) {
	return testAuth.GenerateToken(runID)
}

func validateToken(token string, runID string) (bool, error) {
	return testAuth.ValidateToken(token, runID)
}

func requireAdminAuth(r *http.Request) bool {
	return testAuth.RequireAdminAuth(r)
}

func setAdminSecret(secret string) {
	if secret == "" {
		secret = "admin-dev-secret-change-me"
	}
	testAuth = auth.NewForTest("build-process-watcher-secret-2024-dev", secret)
	testHandlers.SetAuthenticator(testAuth)
	testCleanupService = cleanup.NewService(nil, nil, testAuth)
}

// Handler functions for tests - delegate to internal handlers
func healthHandler(w http.ResponseWriter, r *http.Request) {
	testHandlers.Health(w, r)
}

func authHandler(w http.ResponseWriter, r *http.Request) {
	testHandlers.Auth(w, r)
}

func ingestHandler(w http.ResponseWriter, r *http.Request) {
	testHandlers.Ingest(w, r)
}

func runsHandler(w http.ResponseWriter, r *http.Request) {
	testHandlers.GetRun(w, r)
}

func finishHandler(w http.ResponseWriter, r *http.Request) {
	testHandlers.FinishRun(w, r)
}

func cleanupStaleHandler(w http.ResponseWriter, r *http.Request) {
	testCleanupService.HandleManualStaleCleanup(w, r)
}

// GetMockData returns mock sample data for testing
func getMockData(runID string) []Sample {
	now := time.Now()
	return []Sample{
		{
			Timestamp:   now.Add(-30 * time.Second).UnixMilli(),
			ElapsedTime: 0,
			PID:         "2245",
			Name:        "GradleDaemon",
			HeapUsed:    100,
			HeapCap:     200,
			RSS:         300,
			RunID:       runID,
		},
		{
			Timestamp:   now.Add(-25 * time.Second).UnixMilli(),
			ElapsedTime: 5,
			PID:         "2245",
			Name:        "GradleDaemon",
			HeapUsed:    150,
			HeapCap:     250,
			RSS:         350,
			RunID:       runID,
		},
		{
			Timestamp:   now.Add(-20 * time.Second).UnixMilli(),
			ElapsedTime: 10,
			PID:         "2245",
			Name:        "GradleDaemon",
			HeapUsed:    200,
			HeapCap:     300,
			RSS:         400,
			RunID:       runID,
		},
		{
			Timestamp:   now.Add(-15 * time.Second).UnixMilli(),
			ElapsedTime: 15,
			PID:         "2245",
			Name:        "GradleDaemon",
			HeapUsed:    250,
			HeapCap:     350,
			RSS:         450,
			RunID:       runID,
		},
		{
			Timestamp:   now.Add(-10 * time.Second).UnixMilli(),
			ElapsedTime: 20,
			PID:         "2245",
			Name:        "GradleDaemon",
			HeapUsed:    300,
			HeapCap:     400,
			RSS:         500,
			RunID:       runID,
		},
	}
}
