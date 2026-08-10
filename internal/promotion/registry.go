package promotion

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
)

// ModelVersionForWindow returns the promoted model version for a checkpoint window.
func (r Registry) ModelVersionForWindow(observationWindowS int) (string, bool) {
	for _, model := range r.Models {
		if model.ObservationWindowS == observationWindowS && model.ModelVersion != "" {
			return model.ModelVersion, true
		}
	}
	return "", false
}

// VersionMap returns window -> model version for live scoring configuration.
func (r Registry) VersionMap() map[int]string {
	versions := make(map[int]string, len(r.Models))
	for _, model := range r.Models {
		if model.ModelVersion == "" {
			continue
		}
		versions[model.ObservationWindowS] = model.ModelVersion
	}
	return versions
}

// Normalize sorts and de-duplicates registry entries by checkpoint window.
func (r Registry) Normalize() Registry {
	byWindow := make(map[int]PromotedModel, len(r.Models))
	for _, model := range r.Models {
		if model.ObservationWindowS <= 0 || model.ModelVersion == "" {
			continue
		}
		byWindow[model.ObservationWindowS] = model
	}
	windows := make([]int, 0, len(byWindow))
	for window := range byWindow {
		windows = append(windows, window)
	}
	sort.Ints(windows)

	normalized := Registry{Models: make([]PromotedModel, 0, len(windows))}
	for _, window := range windows {
		normalized.Models = append(normalized.Models, byWindow[window])
	}
	return normalized
}

// LoadRegistry reads promotion metadata from disk. Missing files yield an empty registry.
func LoadRegistry(path string) (Registry, error) {
	if path == "" {
		return Registry{}, fmt.Errorf("registry path is required")
	}
	body, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return Registry{Models: []PromotedModel{}}, nil
		}
		return Registry{}, err
	}
	var registry Registry
	if err := json.Unmarshal(body, &registry); err != nil {
		return Registry{}, err
	}
	if registry.Models == nil {
		registry.Models = []PromotedModel{}
	}
	return registry.Normalize(), nil
}

// SaveRegistry writes promotion metadata for live scoring consumers.
func SaveRegistry(path string, registry Registry) error {
	if path == "" {
		return fmt.Errorf("registry path is required")
	}
	normalized := registry.Normalize()
	body, err := json.MarshalIndent(normalized, "", "  ")
	if err != nil {
		return err
	}
	body = append(body, '\n')
	return os.WriteFile(path, body, 0o644)
}

// LoadQualityReport reads a private quality report used by promotion gates.
func LoadQualityReport(path string) (QualityReport, error) {
	if path == "" {
		return QualityReport{}, fmt.Errorf("quality report path is required")
	}
	body, err := os.ReadFile(path)
	if err != nil {
		return QualityReport{}, err
	}
	var report QualityReport
	if err := json.Unmarshal(body, &report); err != nil {
		return QualityReport{}, err
	}
	return report, nil
}

// LoadGate reads optional gate overrides; missing files return DefaultGate.
func LoadGate(path string) (Gate, error) {
	if path == "" {
		return DefaultGate(), nil
	}
	body, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return DefaultGate(), nil
		}
		return Gate{}, err
	}
	gate := DefaultGate()
	if err := json.Unmarshal(body, &gate); err != nil {
		return Gate{}, err
	}
	return gate, nil
}
