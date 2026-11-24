import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

function loadView(): any {
  const sandbox: any = {
    module: { exports: {} },
    exports: {},
    performance: { now: () => 0 },
    setTimeout,
    clearTimeout,
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (cb: Function) => setTimeout(() => cb(0), 0),
    cancelAnimationFrame: clearTimeout,
    document: { querySelector: () => null },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../frontend/public/playback-clock.js'), 'utf8'),
    sandbox,
  );
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../frontend/public/replay-controls.js'), 'utf8'),
    sandbox,
  );
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../frontend/public/prediction-view.js'), 'utf8'),
    sandbox,
  );
  return sandbox.BpwPredictionView;
}

describe('prediction view model', () => {
  const view = loadView();

  it('normalizes optional, invalid, duplicate, and unordered checkpoints', () => {
    const input = [
      { observation_window_s: 180, status: 'ready' },
      { observation_window_s: 'bad', status: 'ready' },
      { observation_window_s: 60, status: 'pending' },
      { observation_window_s: 60, status: 'ready', risk_level: 'low' },
      { observation_window_s: null, status: 'error' },
    ];

    expect(view.normalizeCheckpoints(input)).toEqual([
      { observation_window_s: 60, status: 'ready', risk_level: 'low' },
      { observation_window_s: 180, status: 'ready' },
    ]);
    expect(input[0].observation_window_s).toBe(180);
  });

  it('selects latest ready and falls back to newest stored checkpoint', () => {
    const checkpoints = view.normalizeCheckpoints([
      { observation_window_s: 60, status: 'ready' },
      { observation_window_s: 120, status: 'error' },
    ]);
    // Checkpoint panels are retired; render ignores stored checkpoints.
    expect(view.render({ prediction_checkpoints: checkpoints }, null).selectedWindow).toBeNull();
    expect(view.render({ prediction_checkpoints: checkpoints }, 120).selectedWindow).toBeNull();
  });

  it('does not render retired reliability checkpoint panels', () => {
    const rendered = view.render({ prediction_checkpoints: [{ observation_window_s: 60, status: 'ready' }] }, null).html;
    expect(rendered).not.toContain('Latest prediction');
    expect(rendered).not.toContain('Checkpoint details');
  });

  it('aligns observed RSS to the latest sample at or before the checkpoint', () => {
    const observed = view.observedAtCheckpoint([
      { Timestamp: 1000, RSS: 10, Name: 'GradleDaemon', PID: 1 },
      { Timestamp: 1000, RSS: 20, Name: 'KotlinCompileDaemon', PID: 2 },
      { Timestamp: 30000, RSS: 20, Name: 'GradleDaemon', PID: 1 },
      { Timestamp: 70000, RSS: 40, Name: 'GradleDaemon', PID: 1 },
    ], { observation_window_s: 60 });
    expect(observed).toEqual({ timestamp: 30000, rss: 40 });
  });

  it('forward-fills processes when calculating aggregate peak RSS', () => {
    expect(view.peakAggregateRss([
      { Timestamp: 1000, RSS: 10, Name: 'GradleDaemon', PID: 1 },
      { Timestamp: 1000, RSS: 20, Name: 'KotlinCompileDaemon', PID: 2 },
      { Timestamp: 2000, RSS: 15, Name: 'GradleDaemon', PID: 1 },
      { Timestamp: 3000, RSS: 25, Name: 'KotlinCompileDaemon', PID: 2 },
    ])).toBe(40);
  });

  it('returns empty marker overlays after reliability retirement', () => {
    const markers = view.buildMarkerData([
      { observation_window_s: 60, status: 'ready', risk_level: 'high' },
    ], [0, 60_000]);
    expect(markers).toEqual({ shapes: [], annotations: [], traces: [] });
  });


  it('supports elapsed axes by returning empty overlays', () => {
    expect(view.buildMarkerData([{ observation_window_s: 60, status: 'ready' }], [0, 60], { axis: 'elapsed' }))
      .toEqual({ shapes: [], annotations: [], traces: [] });
    expect(view.buildMarkerData(null, [0, 60])).toEqual({ shapes: [], annotations: [], traces: [] });
  });

});

describe('per-process memory forecasts', () => {
  const view = loadView();
  const samples = [
    { Timestamp: 1000, Name: 'GradleDaemon', PID: '1', HeapUsed: 10, RSS: 20 },
    { Timestamp: 2000, Name: 'GradleDaemon', PID: '1', HeapUsed: 15, RSS: 25 },
    { Timestamp: 1000, Name: 'KotlinCompileDaemon', PID: '2', RSS: 30 },
    { Timestamp: 1000, Name: 'Other', PID: '3', RSS: 40 },
  ];
  const process_forecasts = [
    { process_name: 'GradleDaemon', pid: '1', metric: 'heap', created_at_ms: 1000, points: [{ target_at_ms: 2000, value_mb: 14 }, { target_at_ms: 20000, value_mb: 18 }] },
    { process_name: 'GradleDaemon', pid: '1', metric: 'heap', created_at_ms: 1500, points: [{ target_at_ms: 2000, value_mb: 16 }] },
    { process_name: 'KotlinCompileDaemon', pid: '2', metric: 'rss', created_at_ms: 1000, points: [{ target_at_ms: 2000, value_mb: 31 }] },
    { process_name: 'KotlinCompileDaemon', pid: '2', metric: 'heap', created_at_ms: 1000, points: [{ target_at_ms: 2000, value_mb: 5 }] },
    { process_name: 'Other', pid: '3', metric: 'rss', created_at_ms: 1000, points: [{ target_at_ms: 2000, value_mb: 42 }] },
  ];

  it('retains forecasts for observed process metrics and matches exact actual times', () => {
    const html = view.render({ samples, process_forecasts }, null).html;
    expect(html).toContain('GradleDaemon · PID 1 · Heap');
    expect(html).toContain('KotlinCompileDaemon · PID 2 · RSS');
    expect(html).not.toContain('KotlinCompileDaemon · PID 2 · Heap');
    expect(html).not.toContain('Other · PID');
    expect(html).toContain('class="actual-trace"');
    expect(html).toContain('class="forecast-trace forecast-trace-latest"');
    expect(html).toContain('class="forecast-band"');
    expect(html).toContain('Elapsed time (seconds)');
    expect(html).toContain('Memory (MB)');
    expect(html).toContain('viewBox="0 0 960 280"');
    expect(html).not.toContain('process-forecast-tables');
    expect(html).not.toContain('Predicted</th>');
  });

  it('overlays predictions on the actual timeline and matches nearby sample times', () => {
    const nearSamples = [
      { Timestamp: 1000, Name: 'GradleDaemon', PID: '1', HeapUsed: 10, RSS: 20 },
      { Timestamp: 4500, Name: 'GradleDaemon', PID: '1', HeapUsed: 12, RSS: 22 },
      { Timestamp: 11000, Name: 'GradleDaemon', PID: '1', HeapUsed: 16, RSS: 26 },
    ];
    const nearForecasts = [
      {
        process_name: 'GradleDaemon',
        pid: '1',
        metric: 'heap',
        created_at_ms: 1000,
        points: [
          { target_at_ms: 11000, value_mb: 15 },
          { target_at_ms: 25000, value_mb: 20 },
        ],
      },
    ];
    const html = view.render({
      samples: nearSamples,
      process_forecasts: nearForecasts,
      prediction_mode: 'predict',
    }, null).html;
    expect(html).toContain('Latest issuance');
    expect(html).toContain('Previous issuances');
    expect(html).toContain('id="forecast-history-mode"');
    expect(html).toContain('original +10/+30/+60 forecast');
    expect(html).toContain('id="forecast-replay-controls"');
    expect(html).toContain('id="btn-forecast-view-live"');
    expect(html).toContain('id="btn-forecast-view-replay"');
    expect(html).toContain('id="forecast-live-status"');
    expect(html).toContain('class="forecast-chart"');
    expect(html).toContain('class="forecast-chart-legend"');
    expect(html).toContain('legend-issuance');
    expect(html).toContain('class="forecast-point forecast-issuance"');
    expect(html).toContain('Issued at 0s');
    expect(html).toContain('class="process-forecast-charts"');
    expect(html).not.toContain('process-forecast-tables');
    expect(html).not.toContain('forecast-table-scroll');
    expect(html).not.toContain('class="chart-legend"');
    expect(html).toContain('data-forecast-chart-host');
    expect(view.actualNear(
      [{ time: 1000, value: 10 }, { time: 4500, value: 12 }],
      5000,
      10000,
    )).toEqual({ time: 4500, value: 12, delta: 500 });
  });

  it('draws one issuance marker per process_forecast created_at', () => {
    const samples = [
      { Timestamp: 0, Name: 'GradleDaemon', PID: '1', HeapUsed: 10, RSS: 20 },
      { Timestamp: 10000, Name: 'GradleDaemon', PID: '1', HeapUsed: 12, RSS: 22 },
      { Timestamp: 20000, Name: 'GradleDaemon', PID: '1', HeapUsed: 14, RSS: 24 },
    ];
    const forecasts = [
      {
        process_name: 'GradleDaemon',
        pid: '1',
        metric: 'heap',
        created_at_ms: 0,
        points: [{ target_at_ms: 10000, value_mb: 11 }],
      },
      {
        process_name: 'GradleDaemon',
        pid: '1',
        metric: 'heap',
        created_at_ms: 10000,
        points: [{ target_at_ms: 20000, value_mb: 13 }],
      },
    ];
    const html = view.render({ samples, process_forecasts: forecasts, prediction_mode: 'predict' }, null).html;
    const markers = html.match(/class="forecast-point forecast-issuance[^"]*"/g) || [];
    expect(markers).toHaveLength(2);
    expect(html).toContain('Issued at 0s');
    expect(html).toContain('Issued at 10s');
    expect(html).toContain('Latest issuance');
    expect(html).toContain('Earlier issuance');
  });

  it('marks expired forecasts and reports horizon accuracy', () => {
    const group = {
      name: 'GradleDaemon',
      pid: '1',
      metric: 'heap',
      actual: [
        { time: 0, value: 100 },
        { time: 20000, value: 110 },
        { time: 50000, value: 150 },
        { time: 80000, value: 160 },
        { time: 100000, value: 170 },
      ],
      predictions: [{
        created: 20000,
        points: [
          { time: 30000, value: 120 },
          { time: 50000, value: 140 },
          { time: 80000, value: 155 },
        ],
      }],
    };
    expect(view.isIssuanceExpired(group.predictions[0], 70000)).toBe(false);
    expect(view.isIssuanceExpired(group.predictions[0], 90000)).toBe(true);

    const activeSvg = view.renderForecastChartSvg(group, 40000, { predictionMode: 'predict' });
    expect(activeSvg).toContain('forecast-trace-latest');
    expect(activeSvg).not.toContain('forecast-trace-expired');
    expect(activeSvg).toContain('Error');

    const expiredSvg = view.renderForecastChartSvg(group, 90000, { predictionMode: 'predict' });
    expect(expiredSvg).toContain('forecast-trace-expired');

    const accuracy = view.forecastAccuracyByHorizon([group]);
    expect(accuracy.find((row: any) => row.horizonS === 30)?.n).toBe(1);
    expect(accuracy.find((row: any) => row.horizonS === 30)?.mae).toBeCloseTo(10);

    const html = view.render({
      samples: [
        { Timestamp: 0, Name: 'GradleDaemon', PID: '1', HeapUsed: 100, RSS: 200 },
        { Timestamp: 20000, Name: 'GradleDaemon', PID: '1', HeapUsed: 110, RSS: 210 },
        { Timestamp: 50000, Name: 'GradleDaemon', PID: '1', HeapUsed: 150, RSS: 250 },
        { Timestamp: 80000, Name: 'GradleDaemon', PID: '1', HeapUsed: 160, RSS: 260 },
      ],
      process_forecasts: [{
        process_name: 'GradleDaemon',
        pid: '1',
        metric: 'heap',
        created_at_ms: 20000,
        points: [
          { target_at_ms: 30000, value_mb: 120 },
          { target_at_ms: 50000, value_mb: 140 },
          { target_at_ms: 80000, value_mb: 155 },
        ],
      }],
      prediction_mode: 'predict',
    }, null).html;
    expect(html).not.toContain('data-forecast-active-meta');
    expect(html).not.toContain('forecast-active-pill');
    expect(html).toContain('data-forecast-accuracy');
    expect(html).toContain('Prediction accuracy');
    expect(html).toContain('marked expired');
  });

  it('shows forecast model engine and inference table for timeline modes', () => {
    const samples = [
      { Timestamp: 1000, Name: 'GradleDaemon', PID: '1', HeapUsed: 100, RSS: 200 },
      { Timestamp: 5000, Name: 'GradleDaemon', PID: '1', HeapUsed: 110, RSS: 210 },
    ];
    const tabpfn = view.render({
      samples,
      prediction_mode: 'tabpfn',
      process_forecasts: [{
        process_name: 'GradleDaemon',
        pid: '1',
        metric: 'heap',
        created_at_ms: 1000,
        method: 'tabpfn',
        model_version: 'tabpfn-timeline-v1',
        points: [{ target_at_ms: 5000, value_mb: 112 }],
      }],
    }, null).html;
    expect(tabpfn).toContain('data-forecast-model');
    expect(tabpfn).toContain('TabPFN GPU');
    expect(tabpfn).toContain('tabpfn-timeline-v1');
    expect(tabpfn).toContain('no BigQuery table');

    const predict = view.render({
      samples,
      prediction_mode: 'predict',
      process_forecasts: [{
        process_name: 'GradleDaemon',
        pid: '1',
        metric: 'heap',
        created_at_ms: 1000,
        method: 'ai_predict',
        model_version: 'bq-ai-predict-tabfm-v1',
        points: [{ target_at_ms: 5000, value_mb: 112 }],
      }],
    }, null).html;
    expect(predict).toContain('TabFM AI.PREDICT');
    expect(predict).toContain('predictive_reliability.tabfm_context');

    const boosted = view.forecastModelSummary({
      prediction_mode: 'bqml-boosted',
      process_forecasts: [{
        method: 'bqml_boosted',
        model_version: 'bpw_process_boosted_v1',
      }],
    });
    expect(boosted.engine).toBe('BQML boosted trees');
    expect(boosted.modelId).toBe('bpw_process_boosted_v1');
    expect(boosted.inferenceTable).toBe('predictive_reliability.bqml_boosted_train');
  });

  it('summarizes issuance latency telemetry in the Predictions panel', () => {
    const html = view.render({
      prediction_mode: 'forecast',
      samples: [
        { Timestamp: 0, Name: 'GradleDaemon', PID: '1', HeapUsed: 100, RSS: 200 },
        { Timestamp: 20000, Name: 'GradleDaemon', PID: '1', HeapUsed: 110, RSS: 210 },
      ],
      process_forecasts: [
        {
          process_name: 'GradleDaemon',
          pid: '1',
          metric: 'heap',
          created_at_ms: 0,
          method: 'ai_forecast',
          latency_ms: 800,
          provider_latency_ms: 700,
          inference_latency_ms: 600,
          points: [
            { target_at_ms: 10000, value_mb: 105 },
            { target_at_ms: 30000, value_mb: 115 },
            { target_at_ms: 60000, value_mb: 125 },
          ],
        },
        {
          process_name: 'GradleDaemon',
          pid: '1',
          metric: 'heap',
          created_at_ms: 20000,
          method: 'last_value',
          fallback: true,
          latency_ms: 1200,
          provider_latency_ms: 50,
          points: [
            { target_at_ms: 30000, value_mb: 110 },
            { target_at_ms: 50000, value_mb: 110 },
            { target_at_ms: 80000, value_mb: 110 },
          ],
        },
      ],
    }, null).html;
    expect(html).toContain('data-forecast-latency');
    expect(html).toContain('forecast-latency-table');
    expect(html).toContain('End-to-end');
    expect(html).toContain('Provider');
    expect(html).toContain('Inference');
    expect(html).toContain('50%');
    expect(html).toContain('1.2s');
    expect(html.indexOf('process-forecast-charts')).toBeLessThan(html.indexOf('data-forecast-latency'));
    const summary = view.forecastLatencySummary({
      process_forecasts: [
        { latency_ms: 100, method: 'ai_forecast', provider_latency_ms: 80 },
        { latency_ms: 300, method: 'ai_forecast', inference_latency_ms: 200, provider_latency_ms: 250 },
      ],
    });
    expect(summary.p50).toBe(100);
    expect(summary.p95).toBe(300);
    expect(summary.inferenceP50).toBe(200);
    expect(summary.providerP50).toBe(80);
  });

  it('keeps replay forecasts anchored to their issuance time', () => {
    const group = {
      name: 'GradleDaemon',
      pid: '1',
      metric: 'heap',
      actual: [
        { time: 0, value: 100 },
        { time: 20000, value: 110 },
        { time: 40000, value: 120 },
        { time: 60000, value: 130 },
        { time: 80000, value: 140 },
      ],
      predictions: [{
        created: 20000,
        points: [
          { time: 30000, value: 112 },
          { time: 50000, value: 118 },
          { time: 80000, value: 125 },
        ],
      }],
    };

    // Before the first issuance, no forecast geometry.
    const early = view.renderForecastChartSvg(group, 0, { predictionMode: 'predict' });
    expect(early).not.toContain('forecast-trace-issuance');
    expect(early).not.toContain('forecast-point forecast-issuance');

    // After issuance, path stays rooted at created_at (20s), not re-anchored to cursor (40s).
    const paths = view.visibleIssuancePaths(group, 40000);
    expect(paths).toHaveLength(1);
    expect(paths[0].created).toBe(20000);
    expect(paths[0].path[0].time).toBe(20000);
    expect(paths[0].horizonPoints.map((point: any) => point.time)).toEqual([30000, 50000, 80000]);

    const midPredict = view.renderForecastChartSvg(group, 40000, { predictionMode: 'predict' });
    expect(midPredict).toContain('forecast-trace-issuance');
    expect(midPredict).toContain('forecast-point forecast-issuance');
    expect(midPredict).toContain('Issued at');
    expect(midPredict).toContain('Predicted');
    expect(midPredict).toContain('Latest issuance');
    expect(midPredict).not.toContain('forecast-trace-forward');
    expect(midPredict).not.toContain('forecast-band');

    const midForecast = view.renderForecastChartSvg(group, 40000, { predictionMode: 'forecast' });
    expect(midForecast).toContain('forecast-trace-issuance');
    expect(midForecast).toContain('Issued at');
    expect(midForecast).not.toContain('forecast-transition-label');
    expect(midForecast).not.toContain('forecast-issuance-flash');
    expect(midForecast).not.toContain('New issuance');
  });

  it('draws per-issuance horizon polylines for forecast mode', () => {
    expect(view.usesIssuancePolylines('forecast')).toBe(true);
    expect(view.usesIssuancePolylines('predict')).toBe(true);
    expect(view.usesIssuancePolylines('tabpfn')).toBe(true);
    expect(view.usesIssuancePolylines('bqml-boosted')).toBe(true);
    const samples = [
      { Timestamp: 0, Name: 'GradleDaemon', PID: '1', HeapUsed: 100, RSS: 200 },
      { Timestamp: 20000, Name: 'GradleDaemon', PID: '1', HeapUsed: 110, RSS: 210 },
      { Timestamp: 40000, Name: 'GradleDaemon', PID: '1', HeapUsed: 120, RSS: 220 },
      { Timestamp: 60000, Name: 'GradleDaemon', PID: '1', HeapUsed: 130, RSS: 230 },
    ];
    const forecasts = [
      {
        process_name: 'GradleDaemon',
        pid: '1',
        metric: 'heap',
        created_at_ms: 20000,
        method: 'timesfm',
        points: [
          { target_at_ms: 30000, value_mb: 112 },
          { target_at_ms: 50000, value_mb: 118 },
          { target_at_ms: 80000, value_mb: 125 },
        ],
      },
      {
        process_name: 'GradleDaemon',
        pid: '1',
        metric: 'heap',
        created_at_ms: 40000,
        method: 'timesfm',
        points: [
          { target_at_ms: 50000, value_mb: 122 },
          { target_at_ms: 70000, value_mb: 128 },
          { target_at_ms: 100000, value_mb: 135 },
        ],
      },
    ];
    const html = view.render({
      samples,
      process_forecasts: forecasts,
      prediction_mode: 'forecast',
    }, null).html;
    expect(html).toContain('data-prediction-mode="forecast"');
    expect(html).toContain('id="forecast-history-mode"');
    expect(html).toContain('data-forecast-history-mode="latest"');
    expect(html).toContain('data-forecast-history-mode="recent"');
    expect(html).toContain('data-forecast-history-mode="all"');
    expect(html).toContain('forecast-toolbar-primary');
    expect(html).toContain('forecast-segmented');
    expect(html).toContain('forecast-trace-issuance');
    expect(html).toContain('forecast-trace-latest');
    expect(html).not.toContain('forecast-trace-prior');
    expect(html).toContain('forecast-horizon');
    expect(html).toContain('legend-horizon');
    expect(html).not.toContain('forecast-band');
    const issuanceMarkers = html.match(/class="forecast-point forecast-issuance[^"]*"/g) || [];
    expect(issuanceMarkers).toHaveLength(2);
    expect(html).toContain('forecast-issuance-prior');
    const horizonMarkers = html.match(/class="forecast-point forecast-horizon/g) || [];
    expect(horizonMarkers.length).toBe(3);

    const group = {
      name: 'GradleDaemon',
      pid: '1',
      metric: 'heap',
      actual: samples.map((sample) => ({ time: sample.Timestamp, value: sample.HeapUsed })),
      predictions: [
        { created: 20000, points: [{ time: 30000, value: 112 }, { time: 50000, value: 118 }, { time: 80000, value: 125 }] },
        { created: 40000, points: [{ time: 50000, value: 122 }, { time: 70000, value: 128 }, { time: 100000, value: 135 }] },
      ],
    };
    expect(view.visibleIssuancePaths(group, 60000, 'latest')).toHaveLength(1);
    expect(view.visibleIssuancePaths(group, 60000, 'recent')).toHaveLength(2);
    expect(view.visibleIssuancePaths(group, 60000, 'all')).toHaveLength(2);
    const allHtml = view.renderForecastChartSvg(group, 60000, {
      predictionMode: 'forecast',
      historyMode: 'all',
    });
    expect(allHtml).toContain('forecast-trace-prior');
    expect(allHtml).toContain('forecast-trace-latest');
  });

  it('switches issuance history mode without resetting the scrubber', () => {
    const samples = [
      { Timestamp: 0, Name: 'GradleDaemon', PID: '1', HeapUsed: 100, RSS: 200 },
      { Timestamp: 20000, Name: 'GradleDaemon', PID: '1', HeapUsed: 110, RSS: 210 },
      { Timestamp: 40000, Name: 'GradleDaemon', PID: '1', HeapUsed: 120, RSS: 220 },
      { Timestamp: 60000, Name: 'GradleDaemon', PID: '1', HeapUsed: 130, RSS: 230 },
    ];
    const forecasts = [
      {
        process_name: 'GradleDaemon',
        pid: '1',
        metric: 'heap',
        created_at_ms: 20000,
        points: [
          { target_at_ms: 30000, value_mb: 112 },
          { target_at_ms: 50000, value_mb: 118 },
          { target_at_ms: 80000, value_mb: 125 },
        ],
      },
      {
        process_name: 'GradleDaemon',
        pid: '1',
        metric: 'heap',
        created_at_ms: 40000,
        points: [
          { target_at_ms: 50000, value_mb: 122 },
          { target_at_ms: 70000, value_mb: 128 },
          { target_at_ms: 100000, value_mb: 135 },
        ],
      },
    ];
    const html = view.render({
      samples,
      process_forecasts: forecasts,
      prediction_mode: 'predict',
    }, null).html;

    const byId = new Map<string, any>();
    const hosts: any[] = [];
    const makeEl = (overrides: Record<string, any> = {}) => {
      const el: any = {
        value: '',
        textContent: '',
        __innerHTML: '',
        listeners: {} as Record<string, Function>,
        dataset: {},
        classList: { toggle: jest.fn() },
        setAttribute: jest.fn(),
        addEventListener: jest.fn((eventName: string, handler: Function) => {
          el.listeners[eventName] = handler;
        }),
        querySelector: (selector: string) => {
          const idMatch = selector.match(/^#(.+)$/);
          return idMatch ? byId.get(idMatch[1]) || null : null;
        },
        querySelectorAll: (selector: string) => (selector === '[data-forecast-chart-host]' ? hosts : []),
        ...overrides,
      };
      Object.defineProperty(el, 'innerHTML', {
        configurable: true,
        get: () => el.__innerHTML,
        set: (value: string) => {
          el.__innerHTML = String(value);
          el.innerHTMLWrites = (el.innerHTMLWrites || 0) + 1;
        },
      });
      return el;
    };

    const dataMatch = html.match(/id="bpw-forecast-replay-data">([\s\S]*?)<\/script>/);
    byId.set('bpw-forecast-replay-data', makeEl({ textContent: dataMatch?.[1] || '[]' }));
    byId.set('forecast-replay-timeline', makeEl({ value: '0' }));
    byId.set('forecast-replay-meta', makeEl());
    byId.set('forecast-replay-time-label', makeEl());
    byId.set('btn-forecast-replay-play', makeEl());
    byId.set('btn-forecast-replay-pause', makeEl());
    byId.set('btn-forecast-replay-reset', makeEl());
    byId.set('forecast-replay-speed', makeEl({ value: '15' }));
    byId.set('btn-forecast-view-live', makeEl());
    byId.set('btn-forecast-view-replay', makeEl());
    byId.set('forecast-live-status', makeEl());
    let historyLatest: any;
    let historyAll: any;
    historyLatest = makeEl({
      id: 'btn-forecast-history-latest',
      getAttribute: (name: string) => (name === 'data-forecast-history-mode' ? 'latest' : null),
      closest: (selector: string) => (selector === '[data-forecast-history-mode]' ? historyLatest : null),
    });
    historyAll = makeEl({
      id: 'btn-forecast-history-all',
      getAttribute: (name: string) => (name === 'data-forecast-history-mode' ? 'all' : null),
      closest: (selector: string) => (selector === '[data-forecast-history-mode]' ? historyAll : null),
    });
    byId.set('forecast-history-mode', makeEl({ id: 'forecast-history-mode' }));
    hosts.push(makeEl());
    const controls = makeEl({
      dataset: { forecastViewMode: 'replay', forecastHistoryMode: 'latest' },
      classList: { toggle: jest.fn() },
      querySelectorAll: (selector: string) => (
        selector === '[data-forecast-history-mode]' ? [historyLatest, historyAll] : []
      ),
    });
    byId.set('forecast-replay-controls', controls);
    const root = makeEl();
    root.querySelector = (selector: string) => {
      const idMatch = selector.match(/^#(.+)$/);
      return idMatch ? byId.get(idMatch[1]) || null : null;
    };
    root.querySelectorAll = (selector: string) => (selector === '[data-forecast-chart-host]' ? hosts : []);

    const controller = view.bindProcessForecastView(root, {
      initialMode: 'replay',
      historyMode: 'latest',
      predictionMode: 'predict',
      data: {
        finished: true,
        prediction_mode: 'predict',
        samples,
        process_forecasts: forecasts,
      },
    });
    const timeline = byId.get('forecast-replay-timeline');
    timeline.value = '2';
    timeline.listeners.input();
    expect(controller.getMode()).toBe('replay');
    expect(hosts[0].innerHTML).toContain('forecast-trace-latest');
    expect(hosts[0].innerHTML).not.toContain('forecast-trace-prior');
    expect(hosts[0].innerHTML).not.toContain('forecast-band');

    controls.listeners.click({ target: historyAll });
    expect(controller.getHistoryMode()).toBe('all');
    expect(hosts[0].innerHTML).toContain('forecast-trace-prior');
    expect(hosts[0].innerHTML).toContain('forecast-trace-latest');
    expect(hosts[0].innerHTML).not.toContain('forecast-band');
    expect(byId.get('forecast-replay-meta').textContent).toContain('Frame 3 / 4');
  });

  it('binds prediction replay controls and scrubs chart frames', () => {
    const html = view.render({
      samples: [
        { Timestamp: 1000, Name: 'GradleDaemon', PID: '1', HeapUsed: 10, RSS: 20 },
        { Timestamp: 5000, Name: 'GradleDaemon', PID: '1', HeapUsed: 14, RSS: 24 },
        { Timestamp: 11000, Name: 'GradleDaemon', PID: '1', HeapUsed: 16, RSS: 26 },
      ],
      process_forecasts: [{
        process_name: 'GradleDaemon',
        pid: '1',
        metric: 'heap',
        created_at_ms: 1000,
        points: [
          { target_at_ms: 5000, value_mb: 13 },
          { target_at_ms: 11000, value_mb: 15 },
        ],
      }],
    }, null).html;

    const byId = new Map<string, any>();
    const hosts: any[] = [];
    const makeEl = (overrides: Record<string, any> = {}) => {
      const el: any = {
        value: '',
        textContent: '',
        __innerHTML: '',
        listeners: {} as Record<string, Function>,
        dataset: {},
        classList: { toggle: jest.fn() },
        setAttribute: jest.fn(),
        addEventListener: jest.fn((eventName: string, handler: Function) => {
          el.listeners[eventName] = handler;
        }),
        querySelector: (selector: string) => {
          const idMatch = selector.match(/^#(.+)$/);
          return idMatch ? byId.get(idMatch[1]) || null : null;
        },
        querySelectorAll: (selector: string) => (selector === '[data-forecast-chart-host]' ? hosts : []),
        ...overrides,
      };
      Object.defineProperty(el, 'innerHTML', {
        configurable: true,
        get: () => el.__innerHTML,
        set: (value: string) => {
          el.__innerHTML = String(value);
          el.innerHTMLWrites = (el.innerHTMLWrites || 0) + 1;
        },
      });
      return el;
    };

    const dataMatch = html.match(/id="bpw-forecast-replay-data">([\s\S]*?)<\/script>/);
    byId.set('bpw-forecast-replay-data', makeEl({ textContent: dataMatch?.[1] || '[]' }));
    byId.set('forecast-replay-timeline', makeEl({ value: '0' }));
    byId.set('forecast-replay-meta', makeEl());
    byId.set('forecast-replay-time-label', makeEl());
    byId.set('btn-forecast-replay-play', makeEl());
    byId.set('btn-forecast-replay-pause', makeEl());
    byId.set('btn-forecast-replay-reset', makeEl());
    byId.set('forecast-replay-speed', makeEl({ value: '15' }));
    byId.set('btn-forecast-view-live', makeEl());
    byId.set('btn-forecast-view-replay', makeEl());
    byId.set('forecast-live-status', makeEl());
    byId.set('forecast-history-mode', makeEl({ id: 'forecast-history-mode' }));
    hosts.push(makeEl());
    const controls = makeEl({
      dataset: { forecastViewMode: 'live', forecastHistoryMode: 'latest' },
      classList: { toggle: jest.fn() },
      querySelectorAll: (selector: string) => (selector === '[data-forecast-history-mode]' ? [] : []),
    });
    byId.set('forecast-replay-controls', controls);
    const root = makeEl();
    root.querySelector = (selector: string) => {
      const idMatch = selector.match(/^#(.+)$/);
      return idMatch ? byId.get(idMatch[1]) || null : null;
    };
    root.querySelectorAll = (selector: string) => (selector === '[data-forecast-chart-host]' ? hosts : []);

    const controller = view.bindProcessForecastView(root, { initialMode: 'live' });
    const timeline = byId.get('forecast-replay-timeline');
    const meta = byId.get('forecast-replay-meta');
    expect(timeline).toBeTruthy();
    expect(controller.getMode()).toBe('live');
    expect(controller.getHistoryMode()).toBe('latest');
    expect(meta.textContent).toContain('Live · sample 3 / 3');
    expect(hosts[0].innerHTML).toContain('class="actual-trace"');
    timeline.value = '0';
    timeline.listeners.input();
    expect(controller.getMode()).toBe('replay');
    expect(meta.textContent).toContain('Frame 1 / 3');
    expect(hosts[0].innerHTML).toContain('class="actual-trace"');
    controller.stop();
  });

  it('keeps actual charts while waiting for laggy timeline forecasts', () => {
    const html = view.render({
      prediction_mode: 'predict',
      finished: false,
      samples: [
        { Timestamp: 1000, Name: 'GradleDaemon', PID: '1', HeapUsed: 10, RSS: 20 },
        { Timestamp: 5000, Name: 'GradleDaemon', PID: '1', HeapUsed: 14, RSS: 24 },
      ],
      process_forecasts: [],
    }, null).html;
    expect(html).toContain('waiting for first forecast');
    expect(html).toContain('btn-forecast-view-live');
    expect(html).toContain('class="actual-trace"');
  });

  it('reports forecast lag for delayed predict issuances', () => {
    const status = view.formatForecastStatus({
      prediction_mode: 'predict',
      samples: [{ Timestamp: 60000, Name: 'GradleDaemon', PID: '1', HeapUsed: 10, RSS: 20 }],
      process_forecasts: [{
        process_name: 'GradleDaemon',
        pid: '1',
        metric: 'heap',
        created_at_ms: 10000,
        method: 'last_value',
        points: [{ target_at_ms: 20000, value_mb: 12 }],
      }],
    }, 'live');
    expect(status).toContain('Live · predict');
    expect(status).toContain('forecast 50s behind samples');
    expect(status).toContain('last_value');
  });

  it('forces Replay for finished runs even when Live was sticky from the live session', () => {
    const sandboxView = loadView();
    const sandboxWindow = (sandboxView as any);
    // preferredForecastViewMode reads window.__bpwForecastViewMode from the VM sandbox.
    const html = (() => {
      const ctx: any = {
        module: { exports: {} },
        exports: {},
        performance: { now: () => 0 },
        setTimeout,
        clearTimeout,
        matchMedia: () => ({ matches: false }),
        requestAnimationFrame: (cb: Function) => setTimeout(() => cb(0), 0),
        cancelAnimationFrame: clearTimeout,
        document: { querySelector: () => null },
        __bpwForecastViewMode: 'live',
      };
      ctx.globalThis = ctx;
      ctx.window = ctx;
      vm.runInNewContext(
        fs.readFileSync(path.join(__dirname, '../frontend/public/prediction-view.js'), 'utf8'),
        ctx,
      );
      expect(ctx.BpwPredictionView.preferredForecastViewMode({ finished: true })).toBe('replay');
      expect(ctx.BpwPredictionView.preferredForecastViewMode({ finished: false })).toBe('live');
      return ctx.BpwPredictionView.render({
        finished: true,
        prediction_mode: 'bqml-boosted',
        samples: [
          { Timestamp: 1000, Name: 'GradleDaemon', PID: '1', HeapUsed: 10, RSS: 20 },
          { Timestamp: 5000, Name: 'GradleDaemon', PID: '1', HeapUsed: 14, RSS: 24 },
        ],
        process_forecasts: [{
          process_name: 'GradleDaemon',
          pid: '1',
          metric: 'heap',
          created_at_ms: 1000,
          method: 'last_value',
          model_version: 'bqml-boosted-last-value-v1',
          points: [{ target_at_ms: 5000, value_mb: 13 }],
        }],
      }, null).html;
    })();

    expect(html).toContain('data-forecast-view-mode="replay"');
    expect(html).toContain('aria-pressed="true">Replay</button>');
    expect(html).toContain('Replay · bqml-boosted');
    expect(sandboxView).toBeTruthy();
  });

  it('treats tabpfn as a timeline prediction mode', () => {
    expect(view.isTimelinePredictionMode('tabpfn')).toBe(true);
    const html = view.render({
      prediction_mode: 'tabpfn',
      samples: [
        { Timestamp: 1000, Name: 'GradleDaemon', PID: '1', HeapUsed: 10, RSS: 20 },
        { Timestamp: 5000, Name: 'GradleDaemon', PID: '1', HeapUsed: 14, RSS: 24 },
      ],
      process_forecasts: [{
        process_name: 'GradleDaemon',
        pid: '1',
        metric: 'heap',
        created_at_ms: 1000,
        method: 'tabpfn',
        model_version: 'tabpfn-timeline-v1',
        points: [{ target_at_ms: 5000, value_mb: 13 }],
      }],
    }, null).html;
    expect(html).toContain('data-prediction-mode="tabpfn"');
    expect(html).toContain('tabpfn');
  });

  it('flips Live to Replay when an in-place update marks the run finished', () => {
    const ctx: any = {
      module: { exports: {} },
      exports: {},
      performance: { now: () => 0 },
      setTimeout,
      clearTimeout,
      matchMedia: () => ({ matches: false }),
      requestAnimationFrame: (cb: Function) => setTimeout(() => cb(0), 0),
      cancelAnimationFrame: clearTimeout,
      document: { querySelector: () => null },
      __bpwForecastViewMode: 'live',
    };
    ctx.globalThis = ctx;
    ctx.window = ctx;
    vm.runInNewContext(
      fs.readFileSync(path.join(__dirname, '../frontend/public/prediction-view.js'), 'utf8'),
      ctx,
    );
    const localView = ctx.BpwPredictionView;
    const liveData = {
      finished: false,
      prediction_mode: 'bqml-boosted',
      samples: [
        { Timestamp: 1000, Name: 'GradleDaemon', PID: '1', HeapUsed: 10, RSS: 20 },
        { Timestamp: 5000, Name: 'GradleDaemon', PID: '1', HeapUsed: 14, RSS: 24 },
        { Timestamp: 9000, Name: 'GradleDaemon', PID: '1', HeapUsed: 16, RSS: 26 },
      ],
      process_forecasts: [{
        process_name: 'GradleDaemon',
        pid: '1',
        metric: 'heap',
        created_at_ms: 1000,
        method: 'last_value',
        points: [
          { target_at_ms: 5000, value_mb: 13 },
          { target_at_ms: 9000, value_mb: 15 },
        ],
      }],
    };
    const html = localView.render(liveData, null).html;
    const byId = new Map<string, any>();
    const hosts: any[] = [];
    const makeEl = (overrides: Record<string, any> = {}) => {
      const el: any = {
        value: '',
        textContent: '',
        __innerHTML: '',
        listeners: {} as Record<string, Function>,
        dataset: {},
        classList: { toggle: jest.fn() },
        setAttribute: jest.fn(),
        addEventListener: jest.fn((eventName: string, handler: Function) => {
          el.listeners[eventName] = handler;
        }),
        querySelector: (selector: string) => {
          const idMatch = selector.match(/^#(.+)$/);
          return idMatch ? byId.get(idMatch[1]) || null : null;
        },
        querySelectorAll: (selector: string) => (selector === '[data-forecast-chart-host]' ? hosts : []),
        ...overrides,
      };
      Object.defineProperty(el, 'innerHTML', {
        configurable: true,
        get: () => el.__innerHTML,
        set: (value: string) => {
          el.__innerHTML = String(value);
          el.innerHTMLWrites = (el.innerHTMLWrites || 0) + 1;
        },
      });
      return el;
    };
    const dataMatch = html.match(/id="bpw-forecast-replay-data">([\s\S]*?)<\/script>/);
    byId.set('bpw-forecast-replay-data', makeEl({ textContent: dataMatch?.[1] || '[]' }));
    byId.set('forecast-replay-timeline', makeEl({ value: '0' }));
    byId.set('forecast-replay-meta', makeEl());
    byId.set('forecast-replay-time-label', makeEl());
    byId.set('btn-forecast-replay-play', makeEl());
    byId.set('btn-forecast-replay-pause', makeEl());
    byId.set('btn-forecast-replay-reset', makeEl());
    byId.set('forecast-replay-speed', makeEl({ value: '15' }));
    byId.set('btn-forecast-view-live', makeEl());
    byId.set('btn-forecast-view-replay', makeEl());
    byId.set('forecast-live-status', makeEl());
    hosts.push(makeEl());
    byId.set('forecast-replay-controls', makeEl({ dataset: { forecastViewMode: 'live' }, classList: { toggle: jest.fn() } }));
    const root = makeEl();
    root.querySelector = (selector: string) => {
      const idMatch = selector.match(/^#(.+)$/);
      return idMatch ? byId.get(idMatch[1]) || null : null;
    };
    root.querySelectorAll = (selector: string) => (selector === '[data-forecast-chart-host]' ? hosts : []);

    const controller = localView.bindProcessForecastView(root, { initialMode: 'live', data: liveData });
    expect(controller.getMode()).toBe('live');
    expect(controller.update({ ...liveData, finished: true })).toBe(true);
    expect(controller.getMode()).toBe('replay');
    expect(ctx.__bpwForecastViewMode).toBe('replay');
    controller.stop();
  });

  it('ignores malformed data and leaves legacy and pending runs usable', () => {
    expect(() => view.render({ samples, process_forecasts: [{ process_name: 'GradleDaemon', pid: 1, metric: 'heap', created_at_ms: 1e20, points: [] }] }, null)).not.toThrow();
    expect(view.render({ samples }, null).html).not.toContain('Process memory forecasts');
    expect(view.render({ predictionEnabled: true }, null).html).not.toContain('Waiting for first checkpoint');
  });

  it('has no local setTimeout frame scheduler for forecast playback', () => {
    const source = fs.readFileSync(path.join(__dirname, '../frontend/public/prediction-view.js'), 'utf8');
    expect(source).toContain('createPlaybackClock');
    expect(source).not.toMatch(/playTimer\s*=\s*setTimeout/);
    expect(source).not.toContain('playTimer');
  });

  it('drives forecast replay with BpwPlaybackClock play/pause/reset/speed lifecycle', () => {
    const sandbox: any = {
      module: { exports: {} },
      exports: {},
      performance: { now: () => sandbox.__now },
      setTimeout,
      clearTimeout,
      matchMedia: () => ({ matches: false }),
      requestAnimationFrame: (cb: Function) => {
        sandbox.__raf = cb;
        return 1;
      },
      cancelAnimationFrame: () => { sandbox.__raf = null; },
      document: { querySelector: () => null },
      __now: 0,
      __raf: null as null | Function,
    };
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    vm.runInNewContext(
      fs.readFileSync(path.join(__dirname, '../frontend/public/playback-clock.js'), 'utf8'),
      sandbox,
    );
    vm.runInNewContext(
      fs.readFileSync(path.join(__dirname, '../frontend/public/replay-controls.js'), 'utf8'),
      sandbox,
    );
    vm.runInNewContext(
      fs.readFileSync(path.join(__dirname, '../frontend/public/prediction-view.js'), 'utf8'),
      sandbox,
    );
    const view = sandbox.BpwPredictionView;

    const html = view.render({
      prediction_mode: 'forecast',
      finished: false,
      samples: [
        { Timestamp: 1000, Name: 'GradleDaemon', PID: '1', HeapUsed: 10, RSS: 20 },
        { Timestamp: 6000, Name: 'GradleDaemon', PID: '1', HeapUsed: 12, RSS: 22 },
        { Timestamp: 11000, Name: 'GradleDaemon', PID: '1', HeapUsed: 14, RSS: 24 },
      ],
      process_forecasts: [{
        process_name: 'GradleDaemon',
        pid: '1',
        metric: 'rss',
        created_at_ms: 1000,
        points: [{ target_at_ms: 16000, value_mb: 30 }],
      }],
    }, null).html;

    const byId = new Map<string, any>();
    const hosts: any[] = [];
    const makeEl = (overrides: any = {}) => {
      const el: any = {
        __innerHTML: '',
        textContent: '',
        value: '0',
        classList: { toggle: jest.fn() },
        dataset: {},
        listeners: {} as Record<string, Function>,
        setAttribute: jest.fn(),
        addEventListener: jest.fn((eventName: string, handler: Function) => {
          el.listeners[eventName] = handler;
        }),
        querySelector: (selector: string) => {
          const idMatch = selector.match(/^#(.+)$/);
          return idMatch ? byId.get(idMatch[1]) || null : null;
        },
        querySelectorAll: (selector: string) => (selector === '[data-forecast-chart-host]' ? hosts : []),
        ...overrides,
      };
      Object.defineProperty(el, 'innerHTML', {
        configurable: true,
        get: () => el.__innerHTML,
        set: (value: string) => {
          el.__innerHTML = String(value);
          el.innerHTMLWrites = (el.innerHTMLWrites || 0) + 1;
        },
      });
      return el;
    };

    const dataMatch = html.match(/id="bpw-forecast-replay-data">([\s\S]*?)<\/script>/);
    byId.set('bpw-forecast-replay-data', makeEl({ textContent: dataMatch?.[1] || '[]' }));
    byId.set('forecast-replay-timeline', makeEl({ value: '0' }));
    byId.set('forecast-replay-meta', makeEl());
    byId.set('forecast-replay-time-label', makeEl());
    const playBtn = makeEl();
    const pauseBtn = makeEl();
    const resetBtn = makeEl();
    const speedSelect = makeEl({ value: '5' });
    byId.set('btn-forecast-replay-play', playBtn);
    byId.set('btn-forecast-replay-pause', pauseBtn);
    byId.set('btn-forecast-replay-reset', resetBtn);
    byId.set('forecast-replay-speed', speedSelect);
    byId.set('btn-forecast-view-live', makeEl());
    byId.set('btn-forecast-view-replay', makeEl());
    byId.set('forecast-live-status', makeEl());
    hosts.push(makeEl());
    byId.set('forecast-replay-controls', makeEl({
      dataset: { forecastViewMode: 'replay' },
      classList: { toggle: jest.fn() },
    }));
    const root = makeEl();
    root.querySelector = (selector: string) => {
      const idMatch = selector.match(/^#(.+)$/);
      return idMatch ? byId.get(idMatch[1]) || null : null;
    };
    root.querySelectorAll = (selector: string) => (selector === '[data-forecast-chart-host]' ? hosts : []);

    const createSpy = jest.spyOn(sandbox.BpwPlaybackClock, 'createPlaybackClock');
    const controller = view.bindProcessForecastView(root, { initialMode: 'replay' });
    expect(controller.getMode()).toBe('replay');

    playBtn.listeners.click();
    expect(createSpy).toHaveBeenCalled();
    const clock = createSpy.mock.results[0].value;
    expect(clock.getState().playing).toBe(true);

    sandbox.__now = 200; // 0.2s wall * 5x => 1s logical; sample spacing is 5s so still frame 0
    const rendersBeforeHold = hosts[0].innerHTML;
    const writesBeforeHold = hosts[0].innerHTMLWrites || 0;
    sandbox.__raf(sandbox.__now);
    expect(hosts[0].innerHTMLWrites || 0).toBe(writesBeforeHold);
    expect(hosts[0].innerHTML).toBe(rendersBeforeHold);
    expect(byId.get('forecast-replay-meta').textContent).toContain('Frame');

    // Advancing past the next sample triggers exactly one SVG redraw.
    sandbox.__now = 1100; // 1.1s wall * 5x => 5.5s logical => frame 1
    sandbox.__raf(sandbox.__now);
    expect(hosts[0].innerHTMLWrites || 0).toBe(writesBeforeHold + 1);
    expect(byId.get('forecast-replay-meta').textContent).toContain('Frame 2 / 3');

    pauseBtn.listeners.click();
    expect(clock.getState().playing).toBe(false);

    speedSelect.value = '50';
    speedSelect.listeners.change();
    expect(clock.getState().speed).toBe(50);

    resetBtn.listeners.click();
    expect(clock.getState().cursorMs).toBe(0);
    expect(clock.getState().playing).toBe(false);

    // Live update while unfinished then finish should sticky-flip to Replay.
    controller.setMode('live');
    expect(controller.getMode()).toBe('live');
    controller.update({
      prediction_mode: 'forecast',
      finished: true,
      samples: [
        { Timestamp: 1000, Name: 'GradleDaemon', PID: '1', HeapUsed: 10, RSS: 20 },
        { Timestamp: 6000, Name: 'GradleDaemon', PID: '1', HeapUsed: 12, RSS: 22 },
        { Timestamp: 11000, Name: 'GradleDaemon', PID: '1', HeapUsed: 14, RSS: 24 },
      ],
      process_forecasts: [{
        process_name: 'GradleDaemon',
        pid: '1',
        metric: 'rss',
        created_at_ms: 1000,
        points: [{ target_at_ms: 16000, value_mb: 30 }],
      }],
    });
    expect(controller.getMode()).toBe('replay');

    const destroySpy = jest.spyOn(clock, 'destroy');
    // Recreate clock for stop coverage after update may have rebuilt it.
    playBtn.listeners.click();
    const activeClock = createSpy.mock.results[createSpy.mock.results.length - 1].value;
    const activeDestroy = jest.spyOn(activeClock, 'destroy');
    controller.stop();
    expect(activeDestroy).toHaveBeenCalled();
    createSpy.mockRestore();
  });

});

describe('public documentation forecast fixture', () => {
  const view = loadView();
  const fixture = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../docs/examples/process-forecasts.json'), 'utf8',
  ));
  const html = view.render(fixture, null).html;
  const groups = JSON.parse(html.match(/id="bpw-forecast-replay-data">(.*?)<\/script>/s)[1]);

  it('renders the synthetic fallback with optional timing and model fields absent', () => {
    expect(fixture.samples).toHaveLength(25);
    expect(fixture.process_forecasts).toHaveLength(4);
    expect(fixture.prediction_mode).toBe('predict');
    expect(view.forecastLatencySummary(fixture).fallbackCount).toBe(4);
    expect(view.forecastLatencySummary(fixture).timedCount).toBe(0);
    expect(view.forecastLatencySummary(fixture).p50).toBeNull();
    expect(html).toContain('last_value');
    expect(groups).toHaveLength(1);
    for (const issuance of fixture.process_forecasts) {
      expect(issuance.points.map((point: any) =>
        (point.target_at_ms - issuance.created_at_ms) / 1000)).toEqual([10, 30, 60]);
      expect(issuance).not.toHaveProperty('latency_ms');
      expect(issuance).not.toHaveProperty('model_version');
    }
  });

  it('reveals issuances without moving targets as history and replay position change', () => {
    const group = groups[0];
    const start = fixture.samples[0].Timestamp;
    expect(view.visibleIssuancePaths(group, start + 19000, 'all')).toHaveLength(0);
    expect(view.visibleIssuancePaths(group, start + 80000, 'latest')).toHaveLength(1);
    expect(view.visibleIssuancePaths(group, start + 80000, 'recent')).toHaveLength(3);
    expect(view.visibleIssuancePaths(group, start + 80000, 'all')).toHaveLength(4);
    const at80 = view.visibleIssuancePaths(group, start + 80000, 'latest')[0];
    const at90 = view.visibleIssuancePaths(group, start + 90000, 'latest')[0];
    expect(at90.horizonPoints).toEqual(at80.horizonPoints);
    expect(at90.created).toBe(start + 80000);
    expect(view.forecastAccuracyByHorizon(groups).map((row: any) => row.n)).toEqual([4, 4, 3]);
  });

  it('keeps legacy runs valid without forecasts or optional latency fields', () => {
    const { process_forecasts, ...legacy } = fixture;
    expect(() => view.render(legacy, null)).not.toThrow();
    expect(view.forecastFreshness(legacy).forecastCount).toBe(0);
    expect(view.render({ samples: legacy.samples }, null).html).not.toContain('forecast-trace');
  });
});

describe('class activity forecasts', () => {
 const view = loadView();
 it('preserves the no-op controller when the panel host is absent', () => {
  expect(view.bindProcessForecastView(null, {data: {prediction_target: 'class_loading'}}).update()).toBe(false);
 });
 const start = 1700000000000;
 const samples = Array.from({length:25}, (_,i) => ({Name:'GradleDaemon',PID:'1',Timestamp:start+i*5000,ClassesLoaded:100+i*10}));
 const issuance = {process_name:'GradleDaemon',pid:'1',metric:'classes_loaded',created_at_ms:start+60000,origin_value_count:220,status:'ready',method:'tabpfn',points:[{target_at_ms:start+120000,predicted_delta_count:120,predicted_total_count:340}]};
 const data = {prediction_mode:'tabpfn',prediction_target:'class_loading',samples,process_activity_forecasts:[issuance]};
 it('uses count units and pending actuals through the public renderer', () => {
  const issued=view.render({...data,samples:samples.slice(0,13)}).html;expect(issued).toContain('Predicted additional classes in 60s: +120');expect(issued).toContain('Observed increase: Pending');expect(issued).not.toContain(' MB');
  const end=view.render(data).html;expect(end).toContain('Observed increase: 120');expect(end).toContain('Class-loading activity');expect(end).not.toContain('Process memory forecasts');
 });
 it('shares memory chart styling and controls while retaining class units', () => {
  const html = view.render(data).html;
  for (const cls of ['forecast-replay-controls', 'forecast-segmented', 'forecast-chart-legend', 'process-forecast-charts', 'process-forecast-chart', 'chart-grid', 'actual-trace', 'forecast-trace-issuance', 'forecast-horizon', 'forecast-issuance']) expect(html).toContain(cls);
  expect(html).toContain('Classes loaded');
  expect(html).toContain('Predicted 340 classes');
  expect(html).toContain('>Pause</button>');
  expect(html).toContain('>Reset</button>');
  expect(html).not.toContain(' MB');
 });
 it('keeps unavailable data empty and never matches across a counter reset', () => {
  expect(view.render(data).html).toContain('Observed increase: 120');
  const reset=samples.map((sample,i)=>({...sample,ClassesLoaded:i===18?1:sample.ClassesLoaded}));
  expect(view.render({...data,samples:reset}).html).toContain('Observed increase: Pending');
  const unavailable=view.render({...data,process_activity_forecasts:[{...issuance,status:'unavailable',points:[]}]}).html;
  expect(unavailable).toContain('Status: unavailable');expect(unavailable).not.toContain('Predicted additional classes');
 });
 it('breaks the actual trace at missing counters and keeps invalid actuals out of tooltips', () => {
  const missing = samples.map((sample, i) => ({...sample, ClassesLoaded: i === 18 ? undefined : sample.ClassesLoaded}));
  const html = view.render({...data, samples: missing}).html;
  expect((html.match(/class="actual-trace"/g) || [])).toHaveLength(2);
  expect(html).toContain('Actual pending');
  expect(html).not.toContain('Actual 340 classes');
 });
 it('does not draw an older forecast as Latest when the newest issuance is unavailable', () => {
  const html = view.render({...data, process_activity_forecasts: [issuance, {...issuance, created_at_ms: start + 120000, status: 'unavailable', points: []}]}).html;
  expect(html).not.toContain('class="forecast-trace forecast-trace-issuance');
  expect(html).toContain('Status: unavailable');
 });
 it('shows completed historical errors while a newer issuance is pending', () => {
  const next={...issuance,created_at_ms:start+120000,origin_value_count:340,points:[{target_at_ms:start+180000,predicted_delta_count:10,predicted_total_count:350}]};
  const html=view.render({...data,process_activity_forecasts:[issuance,next]}).html;
  expect(html).toContain('Class-loading issuance results');
  expect(html).toContain('<td>120</td><td>120</td><td>0</td>');
  expect(html).toContain('<td>10</td><td>Pending</td><td>Pending</td>');
 });
 it('does not mix PIDs and keeps legacy memory rendering', () => {
  const isolated={...data,samples:samples.map(s=>({...s,PID:'2'}))};
  expect(view.render(isolated).html).toContain('Observed increase: Pending');
  expect(view.render({samples:[]}).html).not.toContain('Class-loading activity');
 });
 it('drives class-loading replay via BpwPlaybackClock without recreating speed controls', () => {
  const sandbox: any = {
   module: { exports: {} },
   exports: {},
   performance: { now: () => sandbox.__now },
   setTimeout,
   clearTimeout,
   matchMedia: () => ({ matches: false }),
   requestAnimationFrame: (cb: Function) => {
    sandbox.__raf = cb;
    return 1;
   },
   cancelAnimationFrame: () => { sandbox.__raf = null; },
   document: { querySelector: () => null },
   __now: 0,
   __raf: null as null | Function,
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.runInNewContext(
   fs.readFileSync(path.join(__dirname, '../frontend/public/playback-clock.js'), 'utf8'),
   sandbox,
  );
  vm.runInNewContext(
   fs.readFileSync(path.join(__dirname, '../frontend/public/prediction-view.js'), 'utf8'),
   sandbox,
  );
  const localView = sandbox.BpwPredictionView;

  const byId = new Map<string, any>();
  const historyBtns: any[] = [];
  const makeEl = (overrides: Record<string, any> = {}) => {
   const el: any = {
    value: '',
    min: '0',
    max: '0',
    textContent: '',
    __innerHTML: '',
    dataset: {},
    classList: { toggle: jest.fn() },
    setAttribute: jest.fn(),
    getAttribute: (name: string) => el.attrs?.[name] ?? null,
    closest: (selector: string) => (selector === 'button' && el.isButton ? el : null),
    listeners: {} as Record<string, Function>,
    addEventListener: jest.fn((eventName: string, handler: Function) => {
     el.listeners[eventName] = handler;
    }),
    removeEventListener: jest.fn((eventName: string) => {
     delete el.listeners[eventName];
    }),
    querySelector: (selector: string) => {
     const idMatch = selector.match(/^#(.+)$/);
     if (idMatch) return byId.get(idMatch[1]) || null;
     if (selector === '[data-activity-panel]') return byId.get('__activity-panel') || null;
     if (selector === '.process-forecast-charts') return byId.get('__charts') || null;
     return null;
    },
    querySelectorAll: (selector: string) => (
     selector === '[data-forecast-history-mode]' ? historyBtns : []
    ),
    ...overrides,
   };
   Object.defineProperty(el, 'innerHTML', {
    get: () => el.__innerHTML,
    set: (value: string) => {
     el.__innerHTML = String(value);
     el.innerHTMLWrites = (el.innerHTMLWrites || 0) + 1;
    },
   });
   return el;
  };

  const timeline = makeEl({ id: 'forecast-replay-timeline', value: String(start) });
  const meta = makeEl({ id: 'forecast-replay-meta' });
  const timeLabel = makeEl({ id: 'forecast-replay-time-label' });
  const speedSelect = makeEl({ id: 'forecast-replay-speed', value: '15' });
  const playBtn = makeEl({ id: 'btn-forecast-replay-play', isButton: true });
  const pauseBtn = makeEl({ id: 'btn-forecast-replay-pause', isButton: true });
  const resetBtn = makeEl({ id: 'btn-forecast-replay-reset', isButton: true });
  const liveBtn = makeEl({ id: 'btn-forecast-view-live', isButton: true, dataset: { forecastViewMode: 'live' } });
  const replayBtn = makeEl({ id: 'btn-forecast-view-replay', isButton: true, dataset: { forecastViewMode: 'replay' } });
  const chartsNode = makeEl();
  const controls = makeEl({ id: 'forecast-replay-controls' });
  byId.set('__activity-panel', makeEl());
  byId.set('__charts', chartsNode);
  byId.set('forecast-replay-controls', controls);
  byId.set('forecast-replay-timeline', timeline);
  byId.set('forecast-replay-meta', meta);
  byId.set('forecast-replay-time-label', timeLabel);
  byId.set('forecast-replay-speed', speedSelect);
  byId.set('btn-forecast-replay-play', playBtn);
  byId.set('btn-forecast-replay-pause', pauseBtn);
  byId.set('btn-forecast-replay-reset', resetBtn);
  byId.set('btn-forecast-view-live', liveBtn);
  byId.set('btn-forecast-view-replay', replayBtn);
  const root = makeEl();

  const createSpy = jest.spyOn(sandbox.BpwPlaybackClock, 'createPlaybackClock');
  const controller = localView.bindProcessForecastView(root, {
   data: { ...data, finished: true },
   initialMode: 'replay',
  });
  expect(root.innerHTMLWrites || 0).toBe(0);

  // Start playback and change speed mid-play without replacing root.innerHTML.
  root.listeners.click({ target: playBtn });
  expect(createSpy).toHaveBeenCalledTimes(1);
  sandbox.__now = 1_000; // 1s wall * 15x = 15s logical => frame 4 (index 3)
  sandbox.__raf(sandbox.__now);
  expect(meta.textContent).toBe('Frame 4 / 25');
  expect(root.innerHTMLWrites || 0).toBe(0);

  speedSelect.value = '50';
  root.listeners.change({ target: speedSelect });
  sandbox.__now = 2_000; // +1s wall * 50x = +50s => 65s logical => frame 14 (index 13)
  sandbox.__raf(sandbox.__now);
  expect(meta.textContent).toBe('Frame 14 / 25');
  expect(root.innerHTMLWrites || 0).toBe(0);

  // Scrubbing via input event pauses and jumps without snapping back.
  timeline.value = String(start + 10_000);
  root.listeners.input({ target: timeline });
  expect(meta.textContent).toBe('Frame 3 / 25');
  expect(timeline.value).toBe(String(start + 10_000));

  controller.stop();
  createSpy.mockRestore();
 });
});
