import * as fs from 'fs';
import * as path from 'path';

const runDashboardPath = path.join(__dirname, '../frontend/public/runs/[runId].html');
const demoDashboardPath = path.join(__dirname, '../frontend/public/runs/demo.html');
const demoDataPath = path.join(__dirname, '../frontend/public/demo-run.json');

function extractPredictionHelpers(source: string) {
  const sortMatch = source.match(
    /const predictionCheckpoints = Array\.isArray\(data\.prediction_checkpoints\)\s*\n\s*\? \[\.\.\.data\.prediction_checkpoints\]\.sort\(\(a, b\) => Number\(a\.observation_window_s \|\| 0\) - Number\(b\.observation_window_s \|\| 0\)\)\s*\n\s*: \[\];/,
  );
  expect(sortMatch).not.toBeNull();

  const enabledMatch = source.match(/const predictionEnabled = ([^;]+);/);
  expect(enabledMatch?.[1]).toBe(
    'window.BUILD_PROCESS_WATCHER_CONFIG?.predictiveReliability === true || predictionCheckpoints.length > 0',
  );

  const renderMatch = source.match(
    /const renderPredictionCard = \(checkpoint\) => \{([\s\S]*?)\n            \};/,
  );
  expect(renderMatch).not.toBeNull();

  const colorMatch = source.match(
    /const predictionMarkerColor = \(checkpoint\) => \{([\s\S]*?)\n        \};/,
  );
  expect(colorMatch).not.toBeNull();

  const hoverMatch = source.match(
    /const buildPredictionMarkerHoverText = \(checkpoint\) => \{([\s\S]*?)\n        \};/,
  );
  expect(hoverMatch).not.toBeNull();

  const markerMatch = source.match(
    /const buildPredictionMarkerData = \(checkpoints, timestamps, options = \{\}\) => \{([\s\S]*?)\n        \};/,
  );
  expect(markerMatch).not.toBeNull();

  const formatPredictionValue = (value: unknown, unit: string) => (
    Number.isFinite(Number(value))
      ? `${Number(value).toFixed(Number(value) >= 1000 ? 0 : 1)} ${unit}`
      : 'N/A'
  );
  const formatRiskScore = (score: unknown) => {
    if (!Number.isFinite(Number(score))) return 'N/A';
    const n = Number(score);
    if (n <= 1 && n >= 0) return n.toFixed(2);
    return n >= 100 ? n.toFixed(0) : n.toFixed(1);
  };
  const predictionRiskClass = (riskLevel: unknown) => (
    ['low', 'elevated', 'high'].includes(String(riskLevel)) ? String(riskLevel) : 'unknown'
  );
  const predictionStatusClass = (status: unknown) => (
    ['ready', 'pending', 'skipped', 'error'].includes(String(status)) ? String(status) : 'unknown'
  );
  const escapeHtml = (value: unknown) => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const renderPredictionCard = Function(
    'formatPredictionValue',
    'formatRiskScore',
    'predictionRiskClass',
    'predictionStatusClass',
    'escapeHtml',
    `return (checkpoint) => {${renderMatch?.[1]}\n};`,
  )(
    formatPredictionValue,
    formatRiskScore,
    predictionRiskClass,
    predictionStatusClass,
    escapeHtml,
  ) as (checkpoint: Record<string, unknown>) => string;

  const predictionMarkerColor = Function(
    'predictionRiskClass',
    `return (checkpoint) => {${colorMatch?.[1]}\n};`,
  )(
    predictionRiskClass,
  ) as (checkpoint: Record<string, unknown>) => string;

  const buildPredictionMarkerHoverText = Function(
    'formatPredictionValue',
    'escapeHtml',
    `return (checkpoint) => {${hoverMatch?.[1]}\n};`,
  )(
    formatPredictionValue,
    escapeHtml,
  ) as (checkpoint: Record<string, unknown>) => string;

  const buildPredictionMarkerData = Function(
    'predictionMarkerColor',
    'buildPredictionMarkerHoverText',
    'escapeHtml',
    `return (checkpoints, timestamps, options = {}) => {${markerMatch?.[1]}\n};`,
  )(
    predictionMarkerColor,
    buildPredictionMarkerHoverText,
    escapeHtml,
  ) as (
    checkpoints: Array<Record<string, unknown>>,
    timestamps: number[],
    options?: { axisMode?: string },
  ) => { shapes: any[], annotations: any[], traces: any[] };

  return {
    sortCheckpoints: (data: { prediction_checkpoints?: Array<Record<string, unknown>> }) => (
      Array.isArray(data.prediction_checkpoints)
        ? [...data.prediction_checkpoints].sort(
          (a, b) => Number(a.observation_window_s || 0) - Number(b.observation_window_s || 0),
        )
        : []
    ),
    evaluateEnabled: (predictiveReliability: boolean, checkpointCount: number) => Function(
      'window',
      'predictionCheckpoints',
      `return ${enabledMatch?.[1]};`,
    )(
      { BUILD_PROCESS_WATCHER_CONFIG: { predictiveReliability } },
      { length: checkpointCount },
    ),
    renderPredictionCard,
    predictionMarkerColor,
    buildPredictionMarkerHoverText,
    buildPredictionMarkerData,
  };
}

describe('run dashboard predictions tab', () => {
  const sources = [
    { name: 'run dashboard', source: fs.readFileSync(runDashboardPath, 'utf8') },
    { name: 'demo dashboard', source: fs.readFileSync(demoDashboardPath, 'utf8') },
  ];

  it.each(sources)('$name exposes Dashboard and Predictions tabs', ({ source }) => {
    expect(source).toContain('run-dashboard-tabs');
    expect(source).toContain('data-run-tab="dashboard"');
    expect(source).toContain('data-run-tab="predictions"');
    expect(source).toContain('run-panel-predictions');
    expect(source).toContain('predictionTabHtml');
    expect(source).toContain('predictionPreviewHtml');
    expect(source).toContain('No prediction checkpoints');
    expect(source).toContain('activeRunDashboardTab');
    expect(source).toContain('bindRunDashboardTabs');
    expect(source).toContain('risk_score');
    expect(source).toContain('provider_id');
    expect(source).toContain('model_version');
    expect(source).toContain('prediction-details');
    expect(source).toContain('<summary>Details</summary>');
    expect(source).toContain('buildPredictionMarkerData');
    expect(source).toContain('Prediction checkpoints');
    expect(source).toContain('attachPredictionMarkerInteractions');
    expect(source).toContain('__bpwPredictionMarkerClickBound');
    expect(source).toContain('renderChart(samples, predictionCheckpoints)');
    expect(source).toContain('function renderChart(samples, predictionCheckpoints = [])');
    expect(source).not.toMatch(/prediction-metrics[\s\S]*?\$\{providerBits/);
    expect(source).not.toContain('${predictionHtml}');
  });

  it('renders ready checkpoints when prediction_checkpoints are present', () => {
    const { sortCheckpoints, evaluateEnabled, renderPredictionCard } = extractPredictionHelpers(sources[0].source);
    const checkpoints = sortCheckpoints({
      prediction_checkpoints: [
        {
          observation_window_s: 180,
          status: 'ready',
          risk_level: 'elevated',
          risk_score: 0.4,
          confidence: 'medium',
          predicted_peak_rss_mb: 3080.7,
          predicted_duration_s: 199.7,
          signals: ['memory pressure'],
          provider_id: 'private-provider',
          model_version: 'private-heuristic-v1',
        },
        {
          observation_window_s: 30,
          status: 'ready',
          risk_level: 'elevated',
          risk_score: 0.4,
          confidence: 'medium',
          predicted_peak_rss_mb: 1967.3,
          predicted_duration_s: 32.2,
          signals: ['rapid memory growth'],
        },
        {
          observation_window_s: 60,
          status: 'pending',
          risk_level: 'unknown',
        },
      ],
    });

    expect(checkpoints.map(checkpoint => checkpoint.observation_window_s)).toEqual([30, 60, 180]);
    expect(checkpoints.filter(checkpoint => checkpoint.status === 'ready')).toHaveLength(2);
    expect(evaluateEnabled(false, checkpoints.length)).toBe(true);
    expect(sources[0].source).toContain('Open Predictions');
    expect(sources[0].source).toContain('Checkpoint Windows');

    const withProvider = renderPredictionCard(checkpoints[2] as Record<string, unknown>);
    expect(withProvider).toContain('180s');
    expect(withProvider).toContain('elevated');
    expect(withProvider).toContain('score 0.40');
    expect(withProvider).toContain('medium');
    expect(withProvider).toContain('3081 MB');
    expect(withProvider).toContain('199.7 s');
    expect(withProvider).toContain('memory pressure');
    expect(withProvider).toContain('prediction-details');
    expect(withProvider).toContain('<summary>Details</summary>');
    expect(withProvider).toContain('private-provider');
    expect(withProvider).toContain('private-heuristic-v1');
    const metricsHtml = withProvider.match(/<div class="prediction-metrics">([\s\S]*?)<\/div>\s*(?:<div class="prediction-signals"|<details)/)?.[1] ?? '';
    expect(metricsHtml).toContain('Confidence');
    expect(metricsHtml).toContain('Peak RSS');
    expect(metricsHtml).toContain('Duration');
    expect(metricsHtml).not.toContain('Provider');
    expect(metricsHtml).not.toContain('Model');
    expect(metricsHtml).not.toContain('private-provider');
    expect(metricsHtml).not.toContain('private-heuristic-v1');

    const withoutProvider = renderPredictionCard(checkpoints[0] as Record<string, unknown>);
    expect(withoutProvider).toContain('30s');
    expect(withoutProvider).not.toContain('prediction-details');
    expect(withoutProvider).not.toContain('Provider');
    expect(withoutProvider).not.toContain('Model');
  });

  it('keeps legacy runs without prediction_checkpoints valid and empty-state ready', () => {
    const { sortCheckpoints, evaluateEnabled, buildPredictionMarkerData } = extractPredictionHelpers(sources[0].source);
    const demoData = JSON.parse(fs.readFileSync(demoDataPath, 'utf8'));

    expect(demoData.prediction_checkpoints).toBeUndefined();
    expect(sortCheckpoints({})).toEqual([]);
    expect(sortCheckpoints({ prediction_checkpoints: undefined })).toEqual([]);
    expect(buildPredictionMarkerData([], [1700000000000])).toEqual({ shapes: [], annotations: [], traces: [] });
    expect(buildPredictionMarkerData([{ observation_window_s: 30 }], [])).toEqual({ shapes: [], annotations: [], traces: [] });
    expect(evaluateEnabled(false, 0)).toBe(false);
    expect(evaluateEnabled(true, 0)).toBe(true);
    expect(sources[0].source).toContain('Legacy runs and deployments without predictive reliability omit this data.');
    expect(sources[0].source).toContain('Checkpoints will appear here as observation windows complete.');
  });

  it('builds timestamp-axis memory chart markers for ready checkpoints', () => {
    const {
      buildPredictionMarkerData,
      buildPredictionMarkerHoverText,
      predictionMarkerColor,
    } = extractPredictionHelpers(sources[0].source);
    const firstTimestamp = 1700000000000;
    const checkpoints = [
      {
        observation_window_s: 60,
        status: 'ready',
        risk_level: 'high',
        confidence: 'high',
        predicted_peak_rss_mb: 4096.25,
        predicted_duration_s: 182.3,
        signals: ['rss slope', 'gc churn', 'heap pressure', 'ignored extra'],
      },
    ];

    const markerData = buildPredictionMarkerData(checkpoints, [firstTimestamp, firstTimestamp + 90_000]);

    expect(predictionMarkerColor(checkpoints[0])).toBe('#dc2626');
    expect(markerData.shapes).toHaveLength(1);
    expect(markerData.annotations).toHaveLength(1);
    expect(markerData.traces).toHaveLength(1);
    expect(markerData.shapes[0]).toMatchObject({
      type: 'line',
      xref: 'x',
      yref: 'paper',
      y0: 0,
      y1: 1,
      line: { color: '#dc2626', width: 2, dash: 'dot' },
    });
    expect(markerData.shapes[0].x0).toEqual(new Date(firstTimestamp + 60_000));
    expect(markerData.shapes[0].x1).toEqual(new Date(firstTimestamp + 60_000));
    expect(markerData.annotations[0]).toMatchObject({ text: 'P 60s', showarrow: false });
    expect(markerData.traces[0]).toMatchObject({
      name: 'Prediction checkpoints',
      yaxis: 'y2',
      mode: 'markers',
      hoverinfo: 'text',
      customdata: ['prediction-checkpoint'],
    });
    expect(markerData.traces[0].x).toEqual([new Date(firstTimestamp + 60_000)]);
    expect(markerData.traces[0].text[0]).toContain('Window: 60s');
    expect(markerData.traces[0].text[0]).toContain('Status: ready');
    expect(markerData.traces[0].text[0]).toContain('Risk: high');
    expect(markerData.traces[0].text[0]).toContain('Confidence: high');
    expect(markerData.traces[0].text[0]).toContain('Predicted peak RSS: 4096 MB');
    expect(markerData.traces[0].text[0]).toContain('Predicted duration: 182.3 s');
    expect(markerData.traces[0].text[0]).toContain('Top signals: rss slope, gc churn, heap pressure');
    expect(markerData.traces[0].text[0]).not.toContain('ignored extra');
    expect(buildPredictionMarkerHoverText(checkpoints[0])).toContain('Window: 60s');
  });

  it('builds elapsed-axis and muted non-ready checkpoint markers', () => {
    const { buildPredictionMarkerData, predictionMarkerColor } = extractPredictionHelpers(sources[0].source);
    const checkpoints = [
      { observation_window_s: 30, status: 'pending', risk_level: 'high' },
      { observation_window_s: 90, status: 'ready', risk_level: 'unknown' },
    ];

    const markerData = buildPredictionMarkerData(checkpoints, [1700000000000], { axisMode: 'elapsed' });

    expect(predictionMarkerColor(checkpoints[0])).toBe('#94a3b8');
    expect(predictionMarkerColor(checkpoints[1])).toBe('#64748b');
    expect(markerData.shapes.map(shape => shape.x0)).toEqual([30, 90]);
    expect(markerData.annotations.map(annotation => annotation.text)).toEqual(['pending 30s', 'P 90s']);
    expect(markerData.shapes[0].line).toMatchObject({ color: '#94a3b8', width: 1, dash: 'dot' });
    expect(markerData.shapes[0].opacity).toBe(0.45);
    expect(markerData.traces[0].marker.color).toEqual(['#94a3b8', '#64748b']);
    expect(markerData.traces[0].text[0]).toContain('Status: pending');
  });
});
