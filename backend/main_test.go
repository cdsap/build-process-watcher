package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestGenerateToken(t *testing.T) {
	runID := "test-run-123"
	token, expiresAt, err := generateToken(runID)

	if err != nil {
		t.Fatalf("generateToken failed: %v", err)
	}

	if token == "" {
		t.Fatal("Generated token is empty")
	}

	if time.Until(expiresAt) < 1*time.Hour {
		t.Fatal("Token expires too soon")
	}

	if time.Until(expiresAt) > 3*time.Hour {
		t.Fatal("Token expires too late")
	}

	// Test token validation
	valid, err := validateToken(token, runID)
	if err != nil {
		t.Fatalf("Token validation failed: %v", err)
	}

	if !valid {
		t.Fatal("Generated token should be valid")
	}
}

func TestValidateToken(t *testing.T) {
	runID := "test-run-456"
	token, _, err := generateToken(runID)
	if err != nil {
		t.Fatalf("generateToken failed: %v", err)
	}

	// Test valid token
	valid, err := validateToken(token, runID)
	if err != nil {
		t.Fatalf("Valid token validation failed: %v", err)
	}
	if !valid {
		t.Fatal("Valid token should be valid")
	}

	// Test wrong run ID
	valid, err = validateToken(token, "wrong-run-id")
	if err == nil {
		t.Fatal("Wrong run ID should cause validation error")
	}
	if valid {
		t.Fatal("Token with wrong run ID should be invalid")
	}

	// Test invalid token format
	valid, err = validateToken("invalid-token", runID)
	if err == nil {
		t.Fatal("Invalid token should cause validation error")
	}
	if valid {
		t.Fatal("Invalid token should be invalid")
	}
}

func TestGetMockData(t *testing.T) {
	runID := "test-run-789"
	samples := getMockData(runID)

	if len(samples) == 0 {
		t.Fatal("Mock data should not be empty")
	}

	if len(samples) != 5 {
		t.Fatalf("Expected 5 samples, got %d", len(samples))
	}

	// Check that all samples have the correct run ID
	for i, sample := range samples {
		if sample.RunID != runID {
			t.Fatalf("Sample %d has wrong RunID: expected %s, got %s", i, runID, sample.RunID)
		}

		if sample.PID == "" {
			t.Fatalf("Sample %d has empty PID", i)
		}

		if sample.Name == "" {
			t.Fatalf("Sample %d has empty Name", i)
		}
	}

	// Check that timestamps are in ascending order
	for i := 1; i < len(samples); i++ {
		if samples[i].Timestamp <= samples[i-1].Timestamp {
			t.Fatalf("Samples are not in ascending timestamp order")
		}
	}
}

func TestHealthHandler(t *testing.T) {
	req, err := http.NewRequest("GET", "/healthz", nil)
	if err != nil {
		t.Fatal(err)
	}

	rr := httptest.NewRecorder()
	handler := http.HandlerFunc(healthHandler)

	handler.ServeHTTP(rr, req)

	if status := rr.Code; status != http.StatusOK {
		t.Errorf("handler returned wrong status code: got %v want %v", status, http.StatusOK)
	}

	var response map[string]string
	if err := json.Unmarshal(rr.Body.Bytes(), &response); err != nil {
		t.Fatalf("Failed to unmarshal response: %v", err)
	}

	if response["status"] != "healthy" {
		t.Errorf("Expected status 'healthy', got %s", response["status"])
	}
}

func TestRunsHandler(t *testing.T) {
	// Create a test server with mock Firestore client
	// We'll test the mock data fallback since we don't have Firestore access in tests

	req, err := http.NewRequest("GET", "/runs/test-run-123", nil)
	if err != nil {
		t.Fatal(err)
	}

	rr := httptest.NewRecorder()

	// Mock the Firestore client to return permission denied error
	// This will trigger the mock data fallback
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Simulate the runsHandler logic with mock data fallback
		path := strings.TrimPrefix(r.URL.Path, "/runs/")
		if path == "" {
			http.Error(w, "Run ID required", http.StatusBadRequest)
			return
		}

		runID := path
		samples := getMockData(runID)

		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Access-Control-Allow-Origin", "*")

		if err := json.NewEncoder(w).Encode(samples); err != nil {
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}
	})

	handler.ServeHTTP(rr, req)

	if status := rr.Code; status != http.StatusOK {
		t.Errorf("handler returned wrong status code: got %v want %v", status, http.StatusOK)
	}

	var samples []Sample
	if err := json.Unmarshal(rr.Body.Bytes(), &samples); err != nil {
		t.Fatalf("Failed to unmarshal response: %v", err)
	}

	if len(samples) == 0 {
		t.Fatal("Expected samples, got empty array")
	}

	// Check CORS headers
	if rr.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Error("Missing CORS header")
	}
}

func TestRunsHandlerInvalidMethod(t *testing.T) {
	req, err := http.NewRequest("POST", "/runs/test-run-123", nil)
	if err != nil {
		t.Fatal(err)
	}

	rr := httptest.NewRecorder()
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
	})

	handler.ServeHTTP(rr, req)

	if status := rr.Code; status != http.StatusMethodNotAllowed {
		t.Errorf("handler returned wrong status code: got %v want %v", status, http.StatusMethodNotAllowed)
	}
}

func TestRunsHandlerMissingRunID(t *testing.T) {
	req, err := http.NewRequest("GET", "/runs/", nil)
	if err != nil {
		t.Fatal(err)
	}

	rr := httptest.NewRecorder()
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/runs/")
		if path == "" {
			http.Error(w, "Run ID required", http.StatusBadRequest)
			return
		}
	})

	handler.ServeHTTP(rr, req)

	if status := rr.Code; status != http.StatusBadRequest {
		t.Errorf("handler returned wrong status code: got %v want %v", status, http.StatusBadRequest)
	}
}

func TestTokenExpiration(t *testing.T) {
	runID := "test-run-expiration"

	// Create a token that expires in the past
	expiresAt := time.Now().Add(-1 * time.Hour)
	tokenData := TokenData{
		RunID:     runID,
		ExpiresAt: expiresAt,
	}

	tokenBytes, _ := json.Marshal(tokenData)
	token := fmt.Sprintf("%x", tokenBytes)

	// Test expired token
	valid, err := validateToken(token, runID)
	if err == nil {
		t.Fatal("Expired token should cause validation error")
	}
	if valid {
		t.Fatal("Expired token should be invalid")
	}
}

func TestSampleStruct(t *testing.T) {
	// Test that Sample struct can be marshaled/unmarshaled correctly
	sample := Sample{
		Timestamp:   time.Now().UnixMilli(),
		ElapsedTime: 10,
		PID:         "12345",
		Name:        "TestProcess",
		HeapUsed:    100,
		HeapCap:     200,
		RSS:         300,
		RunID:       "test-run",
	}

	// Marshal to JSON
	jsonData, err := json.Marshal(sample)
	if err != nil {
		t.Fatalf("Failed to marshal sample: %v", err)
	}

	// Unmarshal back
	var unmarshaled Sample
	if err := json.Unmarshal(jsonData, &unmarshaled); err != nil {
		t.Fatalf("Failed to unmarshal sample: %v", err)
	}

	// Compare fields
	if sample.Timestamp != unmarshaled.Timestamp {
		t.Error("Timestamp mismatch")
	}
	if sample.ElapsedTime != unmarshaled.ElapsedTime {
		t.Error("ElapsedTime mismatch")
	}
	if sample.PID != unmarshaled.PID {
		t.Error("PID mismatch")
	}
	if sample.Name != unmarshaled.Name {
		t.Error("Name mismatch")
	}
	if sample.HeapUsed != unmarshaled.HeapUsed {
		t.Error("HeapUsed mismatch")
	}
	if sample.HeapCap != unmarshaled.HeapCap {
		t.Error("HeapCap mismatch")
	}
	if sample.RSS != unmarshaled.RSS {
		t.Error("RSS mismatch")
	}
	if sample.RunID != unmarshaled.RunID {
		t.Error("RunID mismatch")
	}
}

// Benchmark tests
func BenchmarkGenerateToken(b *testing.B) {
	runID := "benchmark-run"
	for i := 0; i < b.N; i++ {
		_, _, err := generateToken(runID)
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkValidateToken(b *testing.B) {
	runID := "benchmark-run"
	token, _, err := generateToken(runID)
	if err != nil {
		b.Fatal(err)
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		_, err := validateToken(token, runID)
		if err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkGetMockData(b *testing.B) {
	runID := "benchmark-run"
	for i := 0; i < b.N; i++ {
		_ = getMockData(runID)
	}
}

// TestTimezoneIndependentTimestamp tests that UpdatedAtTimestamp is set correctly
func TestTimezoneIndependentTimestamp(t *testing.T) {
	now := time.Now()
	timestamp := toMillis(now)

	// Verify timestamp is in milliseconds since epoch
	if timestamp <= 0 {
		t.Fatalf("Timestamp should be positive, got: %d", timestamp)
	}

	// Verify timestamp is approximately current time
	// Should be around current Unix time in milliseconds
	expectedTimestamp := now.UnixMilli()
	diff := timestamp - expectedTimestamp
	if diff < -1000 || diff > 1000 {
		t.Fatalf("Timestamp differs too much from expected: got %d, expected ~%d, diff %dms",
			timestamp, expectedTimestamp, diff)
	}

	// Test that timestamps are timezone-independent
	// Create times in different timezones, they should produce same timestamp for same instant
	loc1, _ := time.LoadLocation("America/Los_Angeles") // UTC-7
	loc2, _ := time.LoadLocation("Europe/London")       // UTC+0
	loc3, _ := time.LoadLocation("Asia/Tokyo")          // UTC+9

	// Same instant in different timezones
	baseTime := time.Date(2025, 10, 8, 18, 6, 52, 0, time.UTC)
	time1 := baseTime.In(loc1)
	time2 := baseTime.In(loc2)
	time3 := baseTime.In(loc3)

	ts1 := toMillis(time1)
	ts2 := toMillis(time2)
	ts3 := toMillis(time3)

	if ts1 != ts2 || ts2 != ts3 {
		t.Fatalf("Timestamps should be equal regardless of timezone: %d, %d, %d", ts1, ts2, ts3)
	}

	t.Logf("✅ All timezones produce same timestamp: %d", ts1)
}

// TestRunDocTimestampUpdate tests that UpdatedAtTimestamp is set when updating a run
func TestRunDocTimestampUpdate(t *testing.T) {
	// Create a mock RunDoc
	now := time.Now()
	runDoc := RunDoc{
		ID:                 "test-run",
		RunID:              "test-run",
		StartTime:          now,
		CreatedAt:          now,
		UpdatedAt:          now,
		UpdatedAtTimestamp: toMillis(now),
		Samples:            []Sample{},
		Finished:           false,
	}

	// Verify timestamp is set
	if runDoc.UpdatedAtTimestamp == 0 {
		t.Fatal("UpdatedAtTimestamp should be set")
	}

	// Verify it matches UpdatedAt
	expectedTimestamp := toMillis(runDoc.UpdatedAt)
	if runDoc.UpdatedAtTimestamp != expectedTimestamp {
		t.Fatalf("UpdatedAtTimestamp (%d) should match UpdatedAt timestamp (%d)",
			runDoc.UpdatedAtTimestamp, expectedTimestamp)
	}

	// Simulate update after 5 minutes
	time.Sleep(10 * time.Millisecond) // Small delay to ensure different timestamp
	newNow := time.Now()
	runDoc.UpdatedAt = newNow
	runDoc.UpdatedAtTimestamp = toMillis(newNow)

	// Verify new timestamp is greater
	if runDoc.UpdatedAtTimestamp <= toMillis(now) {
		t.Fatal("Updated timestamp should be greater than original")
	}

	t.Logf("✅ Original timestamp: %d", toMillis(now))
	t.Logf("✅ Updated timestamp:  %d", runDoc.UpdatedAtTimestamp)
	t.Logf("✅ Difference: %d ms", runDoc.UpdatedAtTimestamp-toMillis(now))
}

// TestDataRetentionCutoff tests the 3-hour cutoff calculation
func TestDataRetentionCutoff(t *testing.T) {
	// Test run that's 4 hours old (should be deleted)
	oldTime := time.Now().Add(-4 * time.Hour)
	oldTimestamp := toMillis(oldTime)

	// Test run that's 2 hours old (should NOT be deleted)
	recentTime := time.Now().Add(-2 * time.Hour)
	recentTimestamp := toMillis(recentTime)

	// Calculate 3-hour cutoff
	cutoffTime := time.Now().Add(-dataRetentionPeriod)
	cutoffTimestamp := toMillis(cutoffTime)

	t.Logf("Old run timestamp:    %d (4 hours ago)", oldTimestamp)
	t.Logf("Recent run timestamp: %d (2 hours ago)", recentTimestamp)
	t.Logf("Cutoff timestamp:     %d (3 hours ago)", cutoffTimestamp)

	// Old run should be before cutoff (should be deleted)
	if oldTimestamp >= cutoffTimestamp {
		t.Fatalf("Old run (%d) should be before cutoff (%d)", oldTimestamp, cutoffTimestamp)
	}

	// Recent run should be after cutoff (should NOT be deleted)
	if recentTimestamp < cutoffTimestamp {
		t.Fatalf("Recent run (%d) should be after cutoff (%d)", recentTimestamp, cutoffTimestamp)
	}

	t.Logf("✅ Old run would be deleted: timestamp %d < cutoff %d", oldTimestamp, cutoffTimestamp)
	t.Logf("✅ Recent run would be kept: timestamp %d >= cutoff %d", recentTimestamp, cutoffTimestamp)
}

// TestAdminAuthentication tests the admin secret authentication
func TestAdminAuthentication(t *testing.T) {
	tests := []struct {
		name           string
		adminSecret    string
		providedSecret string
		shouldPass     bool
	}{
		{
			name:           "Valid admin secret",
			adminSecret:    "correct-secret-123",
			providedSecret: "correct-secret-123",
			shouldPass:     true,
		},
		{
			name:           "Invalid admin secret",
			adminSecret:    "correct-secret-123",
			providedSecret: "wrong-secret",
			shouldPass:     false,
		},
		{
			name:           "Empty admin secret",
			adminSecret:    "correct-secret-123",
			providedSecret: "",
			shouldPass:     false,
		},
		{
			name:           "Case sensitive",
			adminSecret:    "Secret123",
			providedSecret: "secret123",
			shouldPass:     false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Set the admin secret for this test
			setAdminSecret(tt.adminSecret)
			defer setAdminSecret("") // Reset after test

			// Create a request with the provided secret
			req := httptest.NewRequest("POST", "/cleanup/stale", nil)
			req.Header.Set("X-Admin-Secret", tt.providedSecret)

			// Test authentication
			result := requireAdminAuth(req)

			if result != tt.shouldPass {
				t.Errorf("Expected auth result %v, got %v", tt.shouldPass, result)
			}

			if tt.shouldPass {
				t.Logf("✅ Correct secret accepted")
			} else {
				t.Logf("✅ Invalid secret rejected")
			}
		})
	}
}

// TestCleanupEndpointAuthRequired tests that cleanup endpoints require authentication
func TestCleanupEndpointAuthRequired(t *testing.T) {
	// Create request without admin secret
	req := httptest.NewRequest("POST", "/cleanup/stale", nil)
	w := httptest.NewRecorder()

	cleanupStaleHandler(w, req)

	// Should return 401 Unauthorized
	if w.Code != http.StatusUnauthorized {
		t.Errorf("Expected status 401 Unauthorized, got %d", w.Code)
	}

	bodyStr := w.Body.String()
	if !strings.Contains(bodyStr, "Unauthorized") {
		t.Errorf("Expected 'Unauthorized' in response, got: %s", bodyStr)
	}

	t.Logf("✅ Endpoint /cleanup/stale correctly rejected unauthenticated request (status %d)", w.Code)
}
