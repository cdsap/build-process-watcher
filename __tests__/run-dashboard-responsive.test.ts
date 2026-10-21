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
    expect(source).toContain('BpwPredictionView.render');
    expect(source).toContain('predictionTabHtml');
    expect(source).toContain('predictionPreviewHtml');
    expect(source).toContain('data-run-tab="predictions"');

    expect(source).toContain('predictionEnabled');
  });

  it('accepts relative-progress results on existing checkpoint fields without new schema keys', () => {
    expect(source).toContain('prediction-view.js');
    expect(source).not.toContain('relative_progress');
    expect(source).not.toContain('progress_ratio');
    expect(source).not.toContain('progress_pct');
  });
});
