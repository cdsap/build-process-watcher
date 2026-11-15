import * as fs from 'fs';
import * as path from 'path';

const publicDir = path.join(__dirname, '../frontend/public');
const livePage = fs.readFileSync(path.join(publicDir, 'runs/[runId].html'), 'utf8');
const demoPage = fs.readFileSync(path.join(publicDir, 'runs/demo.html'), 'utf8');
const dashboard = fs.readFileSync(path.join(publicDir, 'run-dashboard.js'), 'utf8');

describe('shared run dashboard shell', () => {
  it.each([
    ['live', livePage],
    ['demo', demoPage],
  ])('%s page consumes the shared dashboard assets', (_name, source) => {
    expect(source).toContain('<link rel="stylesheet" href="/run-dashboard.css">');
    expect(source).toContain('<script src="/run-dashboard.js"></script>');
    expect(source).not.toContain('function renderDashboard');
    expect(source).not.toMatch(/<style>[\s\S]*\.chart-wrapper/);
  });

  it('keeps page-specific loading in thin adapters', () => {
    expect(livePage).toContain("mode: 'live'");
    expect(livePage).not.toContain('/demo-run.json');
    expect(demoPage).toContain("mode: 'demo'");
    expect(demoPage).toContain("dataUrl: '/demo-run.json'");
    expect(dashboard.match(/function renderDashboard/g)).toHaveLength(1);
    expect(dashboard).toContain('if (!isLiveDashboard)');
    expect(dashboard).toContain('isLiveDashboard && shouldKeepPollingRun(data)');
  });

  it('loads the live support modules for both surfaces', () => {
    const modules = [
      'playback-clock.js',
      'chart-viewport.js',
      'chart-series-store.js',
      'live-run-controller.js',
      'freshness-view.js',
    ];

    modules.forEach((module) => {
      expect(livePage).toContain(`<script src="/${module}"></script>`);
      expect(demoPage).toContain(`<script src="/${module}"></script>`);
    });
  });
});
