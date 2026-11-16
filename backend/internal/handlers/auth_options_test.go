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
		{name: "empty", query: "", want: authRunOptions{}},
		{name: "disabled", query: "prediction_mode=disabled", want: authRunOptions{Mode: models.PredictionModeDisabled}},
		{name: "legacy reliability", query: "predictive_reliability=true", want: authRunOptions{Mode: models.PredictionModeReliability}},
		{name: "forecast", query: "prediction_mode=forecast", want: authRunOptions{Mode: models.PredictionModeForecast}},
		{name: "export", query: "export_to_bigquery=true", want: authRunOptions{ExportToBigQuery: true}},
		{name: "invalid mode", query: "prediction_mode=invalid", wantErr: "invalid prediction_mode"},
		{name: "conflict", query: "prediction_mode=forecast&predictive_reliability=true", wantErr: "conflicting prediction settings"},
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
