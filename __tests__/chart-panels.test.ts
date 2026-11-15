import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

function loadChartPanels(): any {
  const window: any = {};
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../frontend/public/chart-panels.js'), 'utf8'),
    { window },
  );
  return window.BpwChartPanels;
}

describe('shared chart panel template', () => {
  const chartPanels = loadChartPanels();

  it('renders run dashboard chart IDs with shared experiment chrome', () => {
    const html = chartPanels.render({
      chartIdPrefix: '',
      showGC: true,
      showJIT: true,
      showClasses: true,
      includeUnifiedReplay: true,
      panelContent: {
        memory: { insideContainer: '<div id="memory-tools"></div>' },
      },
    });

    expect(html).toContain('id="bpw-unified-replay"');
    expect(html).toContain('id="bpw-workspace-deck"');
    expect(html).toContain('id="bpw-chart-studio"');
    expect(html).toContain('id="bpw-build-story"');
    expect(html).toContain('id="chart"');
    expect(html).toContain('id="gc-chart"');
    expect(html).toContain('id="jit-time-chart"');
    expect(html).toContain('id="class-rate-chart"');
    expect(html).toMatch(/id="memory-tools"[\s\S]*id="chart"/);
  });

  it('renders replay chart IDs from the single- prefix and omits unavailable panels', () => {
    const html = chartPanels.render({
      chartIdPrefix: 'single-',
      headingLevel: 4,
      chartHeights: { memory: 460, gc: 460, runtime: 400 },
      showGC: false,
      showJIT: true,
      showClasses: false,
      includeUnifiedReplay: true,
      beforeGrid: '<div id="single-replay-controls"></div>',
    });

    expect(html).toContain('id="single-rss"');
    expect(html).toContain('id="single-jit-time"');
    expect(html).toContain('id="single-jit-rate"');
    expect(html).not.toContain('id="single-gc"');
    expect(html).not.toContain('id="single-classes-loaded"');
    expect(html).toMatch(/<h4>Memory Usage Over Time<\/h4>/);
    expect(html).toMatch(/id="single-replay-controls"[\s\S]*id="bpw-charts-grid"/);
  });

  it('is the only source of shared panel-card markup for run and replay', () => {
    const replay = fs.readFileSync(path.join(__dirname, '../frontend/public/replay.js'), 'utf8');
    const runDashboard = fs.readFileSync(path.join(__dirname, '../frontend/public/run-dashboard.js'), 'utf8');
    const runPage = fs.readFileSync(path.join(__dirname, '../frontend/public/runs/[runId].html'), 'utf8');
    const demoPage = fs.readFileSync(path.join(__dirname, '../frontend/public/runs/demo.html'), 'utf8');
    const replayPage = fs.readFileSync(path.join(__dirname, '../frontend/public/replay.html'), 'utf8');

    expect(replay).toContain('BpwChartPanels.render({');
    expect(runDashboard).toContain('BpwChartPanels.render({');
    expect(replay).not.toContain('<div class="bpw-panel-card">');
    expect(runDashboard).not.toContain('<div class="bpw-panel-card">');
    expect(replayPage.indexOf('/chart-panels.js')).toBeLessThan(replayPage.indexOf('/replay.js'));
    expect(runPage.indexOf('/chart-panels.js')).toBeGreaterThan(-1);
    expect(demoPage.indexOf('/chart-panels.js')).toBeGreaterThan(-1);
    expect(runPage.indexOf('/chart-panels.js')).toBeLessThan(runPage.indexOf('/run-dashboard.js'));
    expect(demoPage.indexOf('/chart-panels.js')).toBeLessThan(demoPage.indexOf('/run-dashboard.js'));
  });
});
