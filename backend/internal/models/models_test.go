package models

import (
	"encoding/json"
	"testing"
)

func TestProcessInfo_MarshalJSON(t *testing.T) {
	processInfo := ProcessInfo{
		PID:     "12345",
		Name:    "GradleDaemon",
		VMFlags: []string{"-XX:+UseG1GC", "-XX:MaxHeapSize=2g", "-XX:+UseCompressedOops"},
	}

	jsonData, err := json.Marshal(processInfo)
	if err != nil {
		t.Fatalf("Failed to marshal ProcessInfo: %v", err)
	}

	var unmarshaled ProcessInfo
	if err := json.Unmarshal(jsonData, &unmarshaled); err != nil {
		t.Fatalf("Failed to unmarshal ProcessInfo: %v", err)
	}

	if unmarshaled.PID != processInfo.PID {
		t.Errorf("PID mismatch: expected %s, got %s", processInfo.PID, unmarshaled.PID)
	}
	if unmarshaled.Name != processInfo.Name {
		t.Errorf("Name mismatch: expected %s, got %s", processInfo.Name, unmarshaled.Name)
	}
	if len(unmarshaled.VMFlags) != len(processInfo.VMFlags) {
		t.Errorf("VMFlags length mismatch: expected %d, got %d", len(processInfo.VMFlags), len(unmarshaled.VMFlags))
	}
	for i, flag := range processInfo.VMFlags {
		if i >= len(unmarshaled.VMFlags) || unmarshaled.VMFlags[i] != flag {
			t.Errorf("VMFlags[%d] mismatch: expected %s, got %s", i, flag, func() string {
				if i < len(unmarshaled.VMFlags) {
					return unmarshaled.VMFlags[i]
				}
				return "<nil>"
			}())
		}
	}
}

func TestProcessInfo_EmptyVMFlags(t *testing.T) {
	processInfo := ProcessInfo{
		PID:     "12345",
		Name:    "GradleDaemon",
		VMFlags: []string{},
	}

	jsonData, err := json.Marshal(processInfo)
	if err != nil {
		t.Fatalf("Failed to marshal ProcessInfo with empty VMFlags: %v", err)
	}

	var unmarshaled ProcessInfo
	if err := json.Unmarshal(jsonData, &unmarshaled); err != nil {
		t.Fatalf("Failed to unmarshal ProcessInfo with empty VMFlags: %v", err)
	}

	if len(unmarshaled.VMFlags) != 0 {
		t.Errorf("Expected empty VMFlags, got %d flags", len(unmarshaled.VMFlags))
	}
}

func TestProcessInfo_NilVMFlags(t *testing.T) {
	processInfo := ProcessInfo{
		PID:  "12345",
		Name: "GradleDaemon",
		// VMFlags is nil
	}

	jsonData, err := json.Marshal(processInfo)
	if err != nil {
		t.Fatalf("Failed to marshal ProcessInfo with nil VMFlags: %v", err)
	}

	var unmarshaled ProcessInfo
	if err := json.Unmarshal(jsonData, &unmarshaled); err != nil {
		t.Fatalf("Failed to unmarshal ProcessInfo with nil VMFlags: %v", err)
	}

	if unmarshaled.VMFlags == nil {
		t.Log("VMFlags is nil (this is acceptable)")
	}
}

func TestRunDoc_ProcessInfo(t *testing.T) {
	runDoc := RunDoc{
		ID:      "test-run",
		RunID:   "test-run",
		Samples: []Sample{},
	}

	// Test that ProcessInfo can be nil initially
	if runDoc.ProcessInfo != nil {
		t.Error("ProcessInfo should be nil initially")
	}

	// Initialize ProcessInfo map
	runDoc.ProcessInfo = make(map[string]ProcessInfo)

	// Add process info
	processInfo := ProcessInfo{
		PID:     "12345",
		Name:    "GradleDaemon",
		VMFlags: []string{"-XX:+UseG1GC"},
	}
	runDoc.ProcessInfo["12345"] = processInfo

	if len(runDoc.ProcessInfo) != 1 {
		t.Errorf("Expected 1 process info entry, got %d", len(runDoc.ProcessInfo))
	}

	stored, ok := runDoc.ProcessInfo["12345"]
	if !ok {
		t.Fatal("Process info for PID 12345 not found")
	}

	if stored.PID != processInfo.PID {
		t.Errorf("Stored PID mismatch: expected %s, got %s", processInfo.PID, stored.PID)
	}
}

func TestRunResponse_ProcessInfo(t *testing.T) {
	response := RunResponse{
		Samples:     []Sample{},
		ProcessInfo: make(map[string]ProcessInfo),
		Finished:    false,
	}

	// Add process info
	processInfo := ProcessInfo{
		PID:     "12345",
		Name:    "GradleDaemon",
		VMFlags: []string{"-XX:+UseG1GC", "-XX:MaxHeapSize=2g"},
	}
	response.ProcessInfo["12345"] = processInfo

	// Marshal to JSON to verify it works
	jsonData, err := json.Marshal(response)
	if err != nil {
		t.Fatalf("Failed to marshal RunResponse: %v", err)
	}

	var unmarshaled RunResponse
	if err := json.Unmarshal(jsonData, &unmarshaled); err != nil {
		t.Fatalf("Failed to unmarshal RunResponse: %v", err)
	}

	if len(unmarshaled.ProcessInfo) != 1 {
		t.Errorf("Expected 1 process info entry, got %d", len(unmarshaled.ProcessInfo))
	}

	stored, ok := unmarshaled.ProcessInfo["12345"]
	if !ok {
		t.Fatal("Process info for PID 12345 not found after unmarshal")
	}

	if stored.PID != processInfo.PID {
		t.Errorf("Stored PID mismatch: expected %s, got %s", processInfo.PID, stored.PID)
	}
}

func TestIngestRequest_ProcessInfo(t *testing.T) {
	processInfo := &ProcessInfo{
		PID:     "12345",
		Name:    "GradleDaemon",
		VMFlags: []string{"-XX:+UseG1GC"},
	}

	request := IngestRequest{
		RunID:       "test-run",
		Data:        "00:00:01 | 12345 | GradleDaemon | 100MB | 200MB | 300MB",
		ProcessInfo: processInfo,
	}

	jsonData, err := json.Marshal(request)
	if err != nil {
		t.Fatalf("Failed to marshal IngestRequest: %v", err)
	}

	var unmarshaled IngestRequest
	if err := json.Unmarshal(jsonData, &unmarshaled); err != nil {
		t.Fatalf("Failed to unmarshal IngestRequest: %v", err)
	}

	if unmarshaled.ProcessInfo == nil {
		t.Fatal("ProcessInfo should not be nil")
	}

	if unmarshaled.ProcessInfo.PID != processInfo.PID {
		t.Errorf("PID mismatch: expected %s, got %s", processInfo.PID, unmarshaled.ProcessInfo.PID)
	}
}

func TestIngestRequest_WithoutProcessInfo(t *testing.T) {
	request := IngestRequest{
		RunID:       "test-run",
		Data:        "00:00:01 | 12345 | GradleDaemon | 100MB | 200MB | 300MB",
		ProcessInfo: nil,
	}

	jsonData, err := json.Marshal(request)
	if err != nil {
		t.Fatalf("Failed to marshal IngestRequest without ProcessInfo: %v", err)
	}

	var unmarshaled IngestRequest
	if err := json.Unmarshal(jsonData, &unmarshaled); err != nil {
		t.Fatalf("Failed to unmarshal IngestRequest without ProcessInfo: %v", err)
	}

	if unmarshaled.ProcessInfo != nil {
		t.Error("ProcessInfo should be nil when not provided")
	}
}
