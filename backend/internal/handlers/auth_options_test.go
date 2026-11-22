package handlers

import (
	"net/url"
	"testing"

	"github.com/cdsap/build-process-watcher/backend/internal/models"
)

func TestParseAuthRunOptions(t *testing.T) {
	tests := []struct {
		name    string
		query   string
		want    authRunOptions
		wantErr string
	}{
		{name: "empty", query: "", want: authRunOptions{Target: "memory"}},
		{name: "disabled", query: "prediction_mode=disabled", want: authRunOptions{Target: "memory", Mode: models.PredictionModeDisabled}},
		{name: "forecast", query: "prediction_mode=forecast", want: authRunOptions{Target: "memory", Mode: models.PredictionModeForecast}},
		{name: "throttle", query: "prediction_mode=predict&prediction_throttle_s=20", want: authRunOptions{Target: "memory", Mode: models.PredictionModePredict, ThrottleS: 20}},
		{name: "export", query: "export_to_bigquery=true", want: authRunOptions{Target: "memory", ExportToBigQuery: true}},
		{name: "activity", query: "prediction_mode=tabpfn&prediction_target=class_loading", want: authRunOptions{Target: "class_loading", Mode: models.PredictionModeTabPFN}},
		{name: "invalid target", query: "prediction_mode=predict&prediction_target=class_loading", wantErr: "invalid prediction_target: class_loading requires prediction_mode=tabpfn; otherwise use memory"},
		{name: "unknown target", query: "prediction_mode=tabpfn&prediction_target=jit", wantErr: "invalid prediction_target: class_loading requires prediction_mode=tabpfn; otherwise use memory"},
		{name: "invalid mode", query: "prediction_mode=invalid", wantErr: "invalid prediction_mode"},
		{name: "invalid throttle", query: "prediction_throttle_s=0", wantErr: "invalid prediction_throttle_s"},
		{name: "reliability removed", query: "prediction_mode=reliability", wantErr: "invalid prediction_mode"},
		{name: "legacy reliability rejected", query: "predictive_reliability=true", wantErr: "predictive_reliability is no longer supported; use prediction_mode=forecast|predict|bqml-boosted|tabpfn"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			q, err := url.ParseQuery(tt.query)
			if err != nil {
				t.Fatal(err)
			}
			got, err := parseAuthRunOptions(q)
			if tt.wantErr != "" {
				if err == nil || err.Error() != tt.wantErr {
					t.Fatalf("err=%v, want %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got != tt.want {
				t.Fatalf("got %#v, want %#v", got, tt.want)
			}
		})
	}
}
