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
	Target           string
	Mode             models.PredictionMode
	ThrottleS        int
	ExportToBigQuery bool
}

func parseAuthRunOptions(query url.Values) (authRunOptions, error) {
	if strings.TrimSpace(query.Get("predictive_reliability")) != "" {
		return authRunOptions{}, fmt.Errorf("predictive_reliability is no longer supported; use prediction_mode=forecast|predict|bqml-boosted|tabpfn")
	}
	mode, ok := models.ParsePredictionMode(query.Get("prediction_mode"))
	if !ok {
		return authRunOptions{}, fmt.Errorf("invalid prediction_mode")
	}
	target, valid := models.ParsePredictionTarget(query.Get("prediction_target"), mode)
	if !valid {
		return authRunOptions{}, fmt.Errorf("invalid prediction_target: class_loading requires prediction_mode=predict, forecast, or tabpfn; otherwise use memory")
	}
	// Token-only authentication must preserve the run's selected target. New
	// runs still read as memory when the field is absent; selecting a mode
	// without a target keeps the existing memory default.
	if !query.Has("prediction_target") && mode == models.PredictionModeUnset {
		target = ""
	}
	throttleS, ok := models.ParseThrottleElapsedS(query.Get("prediction_throttle_s"))
	if !ok {
		return authRunOptions{}, fmt.Errorf("invalid prediction_throttle_s")
	}
	return authRunOptions{
		Target:           target,
		Mode:             mode,
		ThrottleS:        throttleS,
		ExportToBigQuery: query.Get("export_to_bigquery") == "true",
	}, nil
}

func (h *Handlers) applyAuthRunOptions(ctx context.Context, runID string, opts authRunOptions) error {
	if h == nil || h.storage == nil {
		return nil
	}
	if opts.Target != "" {
		if err := h.storage.SetRunPredictionTarget(ctx, runID, opts.Target); err != nil {
			return fmt.Errorf("persist prediction target: %w", err)
		}
	}
	mode := opts.Mode
	if mode != models.PredictionModeUnset && mode != models.PredictionModeDisabled {
		if err := h.storage.SetRunPredictionMode(ctx, runID, mode.String()); err != nil {
			return fmt.Errorf("persist prediction mode: %w", err)
		}
	}
	if opts.ThrottleS > 0 {
		if err := h.storage.SetRunPredictionThrottleS(ctx, runID, opts.ThrottleS); err != nil {
			log.Printf("Warning: could not persist prediction_throttle_s for run %s: %v", runID, err)
		}
	}
	if opts.ExportToBigQuery {
		if err := h.storage.SetRunExportToBigquery(ctx, runID, true); err != nil {
			log.Printf("Warning: could not persist export_to_bigquery for run %s: %v", runID, err)
		}
	}
	return nil
}

func boolQueryValue(raw string) bool {
	enabled, err := strconv.ParseBool(strings.TrimSpace(raw))
	return err == nil && enabled
}

func boolQuery(r *http.Request, key string) bool {
	return boolQueryValue(r.URL.Query().Get(key))
}
