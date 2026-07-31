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
    expect(source).toContain('predictionEnabled && predictionCheckpoints.length');

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
});
