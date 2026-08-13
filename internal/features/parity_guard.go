package features

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strconv"
	"strings"

	_ "embed"
)

//go:embed testdata/training_feature_contract.json
var trainingFeatureContractJSON []byte

// Sentinel for fail-closed parity breaks.
var ErrParityBroken = errors.New("live-vs-training feature parity broken")

const (
	IssueMissing     = "missing"
	IssueTypeDrift   = "type_drift"
	IssueWindowGap   = "window_gap"
	IssueWindowExtra = "window_extra"
)

// FeatureSpec is one named typed feature in the private training contract.
type FeatureSpec struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// TrainingContract is the private training-asset feature schema for live scoring.
type TrainingContract struct {
	CheckpointWindowsS []int         `json:"checkpoint_windows_s"`
	Features           []FeatureSpec `json:"features"`
}

// LiveCatalog is the live provider's exported feature schema and checkpoint windows.
type LiveCatalog struct {
	CheckpointWindowsS []int
	Features           []FeatureSpec
}

// ParityIssue is one fail-closed diagnostic for a contract mismatch.
type ParityIssue struct {
	Kind    string
	Feature string
	Detail  string
}

// ParityReport summarizes live-vs-training comparison results.
type ParityReport struct {
	Issues        []ParityIssue
	IgnoredExtras []string
}

// HasBreaks reports whether the comparison found fail-closed issues.
func (r ParityReport) HasBreaks() bool {
	return len(r.Issues) > 0
}

// Err returns a fail-closed error when parity breaks; nil otherwise.
func (r ParityReport) Err() error {
	if !r.HasBreaks() {
		return nil
	}
	parts := make([]string, 0, len(r.Issues))
	for _, issue := range r.Issues {
		parts = append(parts, fmt.Sprintf("%s:%s (%s)", issue.Kind, issue.Feature, issue.Detail))
	}
	msg := "feature parity broken: " + strings.Join(parts, "; ")
	if len(r.IgnoredExtras) > 0 {
		msg += "; ignored live extras: " + strings.Join(r.IgnoredExtras, ",")
	}
	return fmt.Errorf("%w: %s", ErrParityBroken, msg)
}

// DefaultTrainingContract returns the checked-in private training feature contract.
func DefaultTrainingContract() (TrainingContract, error) {
	return ParseTrainingContract(trainingFeatureContractJSON)
}

// ParseTrainingContract decodes and validates a training feature contract asset.
func ParseTrainingContract(raw []byte) (TrainingContract, error) {
	var contract TrainingContract
	if err := json.Unmarshal(raw, &contract); err != nil {
		return TrainingContract{}, fmt.Errorf("decode training feature contract: %w", err)
	}
	if len(contract.CheckpointWindowsS) == 0 {
		return TrainingContract{}, errors.New("training feature contract has no checkpoint windows")
	}
	if len(contract.Features) == 0 {
		return TrainingContract{}, errors.New("training feature contract has no features")
	}
	seen := map[string]bool{}
	for _, feature := range contract.Features {
		name := strings.TrimSpace(feature.Name)
		typ := strings.TrimSpace(feature.Type)
		if name == "" || typ == "" {
			return TrainingContract{}, errors.New("training feature contract contains empty feature name or type")
		}
		if seen[name] {
			return TrainingContract{}, fmt.Errorf("training feature contract duplicates feature %q", name)
		}
		seen[name] = true
	}
	return contract, nil
}

// LiveFeatureCatalog derives the live scoring feature schema from CheckpointRow
// and the private v1 checkpoint window set. Identity fields are excluded.
func LiveFeatureCatalog() LiveCatalog {
	features := make([]FeatureSpec, 0)
	rowType := reflect.TypeOf(CheckpointRow{})
	for i := 0; i < rowType.NumField(); i++ {
		field := rowType.Field(i)
		name, ok := liveFeatureName(field.Name)
		if !ok {
			continue
		}
		features = append(features, FeatureSpec{
			Name: name,
			Type: liveFeatureType(field.Type),
		})
	}
	windows := append([]int(nil), CheckpointWindows...)
	return LiveCatalog{
		CheckpointWindowsS: windows,
		Features:           features,
	}
}

// CompareParity checks live feature extraction against the training contract.
// Extra live-only fields are recorded but do not fail the guard.
func CompareParity(live LiveCatalog, training TrainingContract) ParityReport {
	report := ParityReport{}

	liveWindows := toWindowSet(live.CheckpointWindowsS)
	for _, window := range training.CheckpointWindowsS {
		if !liveWindows[window] {
			report.Issues = append(report.Issues, ParityIssue{
				Kind:    IssueWindowGap,
				Feature: strconv.Itoa(window),
				Detail:  "training checkpoint window missing from live scoring coverage",
			})
		}
	}
	trainingWindows := toWindowSet(training.CheckpointWindowsS)
	for _, window := range live.CheckpointWindowsS {
		if !trainingWindows[window] {
			report.Issues = append(report.Issues, ParityIssue{
				Kind:    IssueWindowExtra,
				Feature: strconv.Itoa(window),
				Detail:  "live checkpoint window absent from training feature contract",
			})
		}
	}

	liveByName := map[string]FeatureSpec{}
	for _, feature := range live.Features {
		liveByName[feature.Name] = feature
	}
	for _, want := range training.Features {
		got, ok := liveByName[want.Name]
		if !ok {
			report.Issues = append(report.Issues, ParityIssue{
				Kind:    IssueMissing,
				Feature: want.Name,
				Detail:  "training feature missing from live extraction (renamed or dropped)",
			})
			continue
		}
		if got.Type != want.Type {
			report.Issues = append(report.Issues, ParityIssue{
				Kind:    IssueTypeDrift,
				Feature: want.Name,
				Detail:  fmt.Sprintf("live type %q != training type %q", got.Type, want.Type),
			})
		}
		delete(liveByName, want.Name)
	}

	extras := make([]string, 0, len(liveByName))
	for name := range liveByName {
		extras = append(extras, name)
	}
	sort.Strings(extras)
	report.IgnoredExtras = extras
	return report
}

// ValidateTrainingParity fails closed when live features diverge from the
// checked-in training feature contract. Safe for CI and provider startup.
func ValidateTrainingParity() error {
	training, err := DefaultTrainingContract()
	if err != nil {
		return err
	}
	return CompareParity(LiveFeatureCatalog(), training).Err()
}

func toWindowSet(windows []int) map[int]bool {
	set := make(map[int]bool, len(windows))
	for _, window := range windows {
		set[window] = true
	}
	return set
}

func liveFeatureName(field string) (string, bool) {
	switch field {
	case "RunID", "ObservationWindowS":
		return "", false
	case "SampleCount":
		return "sample_count", true
	case "ProcessCount":
		return "process_count", true
	case "MaxElapsedS":
		return "max_elapsed_s", true
	case "FirstElapsedS":
		return "first_elapsed_s", true
	case "PeakRSSMB":
		return "peak_rss_mb", true
	case "FirstRSSMB":
		return "first_rss_mb", true
	case "LatestRSSMB":
		return "latest_rss_mb", true
	case "RSSGrowthMBPerMin":
		return "rss_growth_mb_per_min", true
	case "HeapUtilization":
		return "heap_utilization", true
	case "GCTimeRatio":
		return "gc_time_ratio", true
	case "JITCompiledMethods":
		return "jit_compiled_methods", true
	case "JITFailedCompilations":
		return "jit_failed_compilations", true
	case "JITCompilationTimeMs":
		return "jit_compilation_time_ms", true
	case "ClassesLoaded":
		return "classes_loaded", true
	case "ClassLoadTimeMs":
		return "class_load_time_ms", true
	default:
		// Unknown exported fields surface as extras unless named explicitly above.
		return toSnakeCase(field), true
	}
}

func liveFeatureType(t reflect.Type) string {
	switch t.Kind() {
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return "int"
	case reflect.Float32, reflect.Float64:
		return "float64"
	case reflect.String:
		return "string"
	case reflect.Bool:
		return "bool"
	case reflect.Pointer:
		if t.Elem().Kind() == reflect.Int ||
			t.Elem().Kind() == reflect.Int8 ||
			t.Elem().Kind() == reflect.Int16 ||
			t.Elem().Kind() == reflect.Int32 ||
			t.Elem().Kind() == reflect.Int64 {
			return "optional_int"
		}
		return "optional_" + liveFeatureType(t.Elem())
	default:
		return t.String()
	}
}

func toSnakeCase(name string) string {
	var b strings.Builder
	for i, r := range name {
		if i > 0 && r >= 'A' && r <= 'Z' {
			b.WriteByte('_')
		}
		b.WriteRune(r)
	}
	return strings.ToLower(b.String())
}
