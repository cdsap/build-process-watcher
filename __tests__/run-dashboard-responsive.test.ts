import * as fs from 'fs';
import * as path from 'path';

describe('run dashboard responsive layout', () => {
  const source = [
    '../frontend/public/runs/[runId].html',
    '../frontend/public/run-dashboard.js',
    '../frontend/public/run-dashboard.css',
    '../frontend/public/bpw-ui.css',
  ].map(relativePath => fs.readFileSync(path.join(__dirname, relativePath), 'utf8')).join('\n');

  it('allows chart wrappers to shrink to the mobile viewport', () => {
    const mobileRules = source.match(/@media \(max-width: 560px\)\s*{([\s\S]*?)\n\}/);

    expect(mobileRules).not.toBeNull();
    expect(mobileRules?.[1]).toMatch(/\.chart-wrapper\s*{[^}]*min-width:\s*0\s*;/);
    expect(mobileRules?.[1]).not.toMatch(/\.chart-wrapper\s*{[^}]*min-width:\s*[1-9]\d*px\s*;/);
  });

  it('renders timeline predictions from process forecasts', () => {
    expect(source).toContain('process_forecasts');
    expect(source).toContain('BpwPredictionView.render');
    expect(source).toContain('predictionTabHtml');
    expect(source).toContain('predictionPreviewHtml');
    expect(source).toContain('data-open-predictions');

    expect(source).toContain('predictionEnabled');
  });

  it('accepts relative-progress results on existing checkpoint fields without new schema keys', () => {
    expect(source).toContain('prediction-view.js');
    expect(source).not.toContain('relative_progress');
    expect(source).not.toContain('progress_ratio');
    expect(source).not.toContain('progress_pct');
  });
});
