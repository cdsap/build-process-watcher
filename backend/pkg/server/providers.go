package server

import (
	"context"
	"log"
	"strings"
	"time"

	"github.com/cdsap/build-process-watcher/backend/internal/predictionqueue"
	"github.com/cdsap/build-process-watcher/backend/pkg/predictor"
)

type timelineProviderSpec struct {
	enabled   bool
	timeout   time.Duration
	construct func(predictor.RemoteForecastConfig) (*predictor.RemoteForecastProvider, error)
}

func buildTimelineProviders(base predictor.RemoteForecastConfig, specs []timelineProviderSpec) (forecast, tab, bqml predictor.ForecastProvider, firstErr error) {
	out := make([]predictor.ForecastProvider, len(specs))
	for i := range out {
		out[i] = predictor.NoopForecastProvider{}
	}
	for i, spec := range specs {
		if !spec.enabled {
			continue
		}
		cfg := base
		cfg.Timeout = spec.timeout
		remote, err := spec.construct(cfg)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		out[i] = remote
	}
	for len(out) < 3 {
		out = append(out, predictor.NoopForecastProvider{})
	}
	return out[0], out[1], out[2], firstErr
}

func newPredictionScheduler(ctx context.Context, options Options) (predictionqueue.Scheduler, func() error) {
	queue := strings.TrimSpace(options.PredictionTasksQueue)
	location := strings.TrimSpace(firstNonEmpty(options.PredictionTasksLocation, "us-central1"))
	targetURL := strings.TrimSpace(options.PredictionJobURL)
	token := strings.TrimSpace(options.PredictionJobToken)
	if queue == "" || targetURL == "" || token == "" {
		log.Printf("🔮 Prediction job queue disabled (set PREDICTION_TASKS_QUEUE, PREDICTION_JOB_URL, PREDICTION_JOB_TOKEN to enable Cloud Tasks offload)")
		return predictionqueue.Noop{}, nil
	}
	mode := strings.TrimSpace(options.PredictionThrottleMode)
	if mode == "" {
		mode = "predict"
	}
	sched, err := predictionqueue.NewCloudTasks(ctx, predictionqueue.CloudTasksConfig{
		ProjectID:    options.ProjectID,
		Location:     location,
		Queue:        queue,
		TargetURL:    targetURL,
		AuthToken:    token,
		ThrottleMode: mode,
	})
	if err != nil {
		log.Printf("🔮 Prediction Cloud Tasks scheduler disabled: %v", err)
		return predictionqueue.Noop{}, nil
	}
	return sched, sched.Close
}

func providerOrNoop(provider predictor.Provider) predictor.Provider {
	if provider == nil {
		return predictor.NoopProvider{}
	}
	return provider
}
