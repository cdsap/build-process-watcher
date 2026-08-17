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
    expect(source).not.toContain('${predictionHtml}');
  });

  it('renders ready checkpoints when prediction_checkpoints are present', () => {
    const { sortCheckpoints, evaluateEnabled } = extractPredictionHelpers(sources[0].source);
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
  });

  it('keeps legacy runs without prediction_checkpoints valid and empty-state ready', () => {
    const { sortCheckpoints, evaluateEnabled } = extractPredictionHelpers(sources[0].source);
    const demoData = JSON.parse(fs.readFileSync(demoDataPath, 'utf8'));

    expect(demoData.prediction_checkpoints).toBeUndefined();
    expect(sortCheckpoints({})).toEqual([]);
    expect(sortCheckpoints({ prediction_checkpoints: undefined })).toEqual([]);
    expect(evaluateEnabled(false, 0)).toBe(false);
    expect(evaluateEnabled(true, 0)).toBe(true);
    expect(sources[0].source).toContain('Legacy runs and deployments without predictive reliability omit this data.');
    expect(sources[0].source).toContain('Checkpoints will appear here as observation windows complete.');
  });
});
