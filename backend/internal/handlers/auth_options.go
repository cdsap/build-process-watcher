package handlers

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/cdsap/build-process-watcher/backend/internal/models"
)

// authRunOptions is the parsed /auth/run query surface before token minting.
type authRunOptions struct {
	Mode             models.PredictionMode
	ExportToBigQuery bool
}

func parseAuthRunOptions(query url.Values) (authRunOptions, error) {
	if strings.TrimSpace(query.Get("predictive_reliability")) != "" {
		return authRunOptions{}, fmt.Errorf("predictive_reliability is no longer supported; use prediction_mode=forecast|predict|bqml-boosted")
	}
	mode, ok := models.ParsePredictionMode(query.Get("prediction_mode"))
	if !ok {
		return authRunOptions{}, fmt.Errorf("invalid prediction_mode")
	}
	return authRunOptions{
		Mode:             mode,
		ExportToBigQuery: query.Get("export_to_bigquery") == "true",
	}, nil
}

func (h *Handlers) applyAuthRunOptions(ctx context.Context, runID string, opts authRunOptions) {
	if h == nil || h.storage == nil {
		return
	}
	mode := opts.Mode
	if mode != models.PredictionModeUnset && mode != models.PredictionModeDisabled {
		if err := h.storage.SetRunPredictionMode(ctx, runID, mode.String()); err != nil {
			log.Printf("Warning: could not persist prediction mode for run %s: %v", runID, err)
		}
	}
	if opts.ExportToBigQuery {
		if err := h.storage.SetRunExportToBigquery(ctx, runID, true); err != nil {
			log.Printf("Warning: could not persist export_to_bigquery for run %s: %v", runID, err)
		}
	}
}

func boolQueryValue(raw string) bool {
	enabled, err := strconv.ParseBool(strings.TrimSpace(raw))
	return err == nil && enabled
}

func boolQuery(r *http.Request, key string) bool {
	return boolQueryValue(r.URL.Query().Get(key))
}
