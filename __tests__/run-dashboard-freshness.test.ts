import * as fs from 'fs';
import * as path from 'path';

const page = path.join(__dirname, '../frontend/public/runs/[runId].html');

describe('run dashboard freshness integration', () => {
  it('loads and renders opt-in freshness diagnostics after dashboard paint', () => {
    const source = `${fs.readFileSync(page, 'utf8')}\n${fs.readFileSync(
      path.join(__dirname, '../frontend/public/run-dashboard.js'),
      'utf8',
    )}`;
    expect(source).toContain('<script src="/freshness-view.js"></script>');
    expect(source).toContain('id="freshness-diagnostics"');
    expect(source).toContain('run-header-actions');
    expect(source).toContain('BpwFreshnessView.update');
    expect(source).toContain('performance.now()');
    expect(source).toContain('requestAnimationFrame');
  });
});
