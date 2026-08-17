import * as fs from 'fs';
import * as path from 'path';

describe('run dashboard responsive layout', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../frontend/public/runs/[runId].html'),
    'utf8',
  );

  it('allows chart wrappers to shrink to the mobile viewport', () => {
    const mobileRules = source.match(/@media \(max-width: 480px\)\s*{([\s\S]*?)\n\s*}\n\s*}/);

    expect(mobileRules).not.toBeNull();
    expect(mobileRules?.[1]).toMatch(/\.chart-wrapper\s*{[^}]*min-width:\s*0\s*;/);
    expect(mobileRules?.[1]).not.toMatch(/\.chart-wrapper\s*{[^}]*min-width:\s*[1-9]\d*px\s*;/);
  });

  it('renders predictive reliability when checkpoints are present even if config is disabled', () => {
    expect(source).toContain('prediction_checkpoints');
    expect(source).toContain('window.BUILD_PROCESS_WATCHER_CONFIG?.predictiveReliability === true || predictionCheckpoints.length > 0');
    expect(source).toContain('predictionTabHtml');
    expect(source).toContain('predictionPreviewHtml');
    expect(source).toContain('data-run-tab="predictions"');

    const predicate = source.match(/const predictionEnabled = ([^;]+);/)?.[1];
    expect(predicate).toBeDefined();

    const evaluatePredicate = (predictiveReliability: boolean, checkpointCount: number) => Function(
      'window',
      'predictionCheckpoints',
      `return ${predicate};`,
    )(
      { BUILD_PROCESS_WATCHER_CONFIG: { predictiveReliability } },
      { length: checkpointCount },
    );

    expect(evaluatePredicate(false, 1)).toBe(true);
    expect(evaluatePredicate(false, 0)).toBe(false);
  });

  it('accepts relative-progress results on existing checkpoint fields without new schema keys', () => {
    expect(source).toContain(
      '[...data.prediction_checkpoints].sort((a, b) => Number(a.observation_window_s || 0) - Number(b.observation_window_s || 0))',
    );
    expect(source).not.toContain('relative_progress');
    expect(source).not.toContain('progress_ratio');
    expect(source).not.toContain('progress_pct');

    const sortCheckpoints = (data: { prediction_checkpoints?: Array<Record<string, unknown>> }) => (
      Array.isArray(data.prediction_checkpoints)
        ? [...data.prediction_checkpoints].sort(
          (a, b) => Number(a.observation_window_s || 0) - Number(b.observation_window_s || 0),
        )
        : []
    );

    expect(sortCheckpoints({})).toEqual([]);
    expect(sortCheckpoints({ prediction_checkpoints: undefined })).toEqual([]);

    const sorted = sortCheckpoints({
      prediction_checkpoints: [
        { observation_window_s: 247, status: 'ready', risk_level: 'low' },
        { observation_window_s: 91, status: 'ready', risk_level: 'elevated' },
      ],
    });
    expect(sorted.map(checkpoint => checkpoint.observation_window_s)).toEqual([91, 247]);
    expect(sorted.every(checkpoint => !('relative_progress' in checkpoint))).toBe(true);
  });
});
