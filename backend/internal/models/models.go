package models

import "time"

// Sample represents a single monitoring sample
type Sample struct {
	Timestamp   int64  `firestore:"timestamp"`
	ElapsedTime int    `firestore:"elapsed_time"`
	PID         string `firestore:"pid"`
	Name        string `firestore:"name"`
	HeapUsed    int    `firestore:"heap_used"`
	HeapCap     int    `firestore:"heap_cap"`
	RSS         int    `firestore:"rss"`
	GCTime      int    `firestore:"gc_time,omitempty"` // GC time in milliseconds, optional
	RunID       string `firestore:"run_id"`
}

// ProcessInfo contains information about a specific process
type ProcessInfo struct {
	PID     string   `firestore:"pid"`
	Name    string   `firestore:"name"`
	VMFlags []string `firestore:"vm_flags"`
}

// ProcessDoc represents a processes document in Firestore (one per run)
type ProcessDoc struct {
	RunID              string                 `firestore:"run_id"`
	ProcessInfo        map[string]ProcessInfo `firestore:"process_info"` // PID -> ProcessInfo map
	CreatedAt          time.Time              `firestore:"created_at"`
	UpdatedAt          time.Time              `firestore:"updated_at"`
	UpdatedAtTimestamp int64                  `firestore:"updated_at_timestamp"` // Unix millis for timezone-independent queries
	ExpireAt           time.Time              `firestore:"expire_at,omitempty"` // TTL field - set manually in Firestore, used by TTL policy
}

// RunDoc represents a monitoring run document in Firestore
type RunDoc struct {
	ID                 string    `firestore:"id"`
	RunID              string    `firestore:"run_id"`
	StartTime          time.Time `firestore:"start_time"`
	EndTime            time.Time `firestore:"end_time,omitempty"`
	CreatedAt          time.Time `firestore:"created_at"`
	UpdatedAt          time.Time `firestore:"updated_at"`
	UpdatedAtTimestamp int64     `firestore:"updated_at_timestamp"` // Unix millis for timezone-independent queries
	Samples            []Sample  `firestore:"samples"`
	Finished           bool      `firestore:"finished,omitempty"`
	FinishedAt         time.Time `firestore:"finished_at,omitempty"`
	ExpireAt           time.Time `firestore:"expire_at,omitempty"` // TTL field - set manually in Firestore, used by TTL policy
}

// RunResponse is the API response for a run
type RunResponse struct {
	Samples     []Sample               `json:"samples"`
	ProcessInfo map[string]ProcessInfo `json:"process_info,omitempty"`
	Finished    bool                   `json:"finished"`
	FinishedAt  *time.Time             `json:"finished_at,omitempty"`
	UpdatedAt   time.Time              `json:"updated_at"`
}

// TokenRequest is the request body for token generation
type TokenRequest struct {
	RunID string `json:"run_id"`
}

// TokenResponse is the response containing the JWT token
type TokenResponse struct {
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expires_at"`
}

// TokenData contains the data encoded in the JWT
type TokenData struct {
	RunID     string    `json:"run_id"`
	ExpiresAt time.Time `json:"expires_at"`
	CreatedAt time.Time `json:"created_at"`
}

// IngestRequest is the request body for data ingestion
type IngestRequest struct {
	RunID       string       `json:"run_id"`
	Data        string       `json:"data"`
	ProcessInfo *ProcessInfo `json:"process_info,omitempty"` // Optional: VM flags for a new process
}
