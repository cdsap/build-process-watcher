import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

function loadCharts() {
  const sandbox: any = {
    module: { exports: {} },
    exports: {},
    window: { innerWidth: 1200 },
    document: {
      getElementById: jest.fn(() => ({ data: [], on: jest.fn() })),
    },
    addEventListener: jest.fn(),
    Plotly: {
      newPlot: jest.fn(),
      react: jest.fn(),
      Plots: { resize: jest.fn() },
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;

  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../frontend/public/compare-shared.js'), 'utf8'),
    sandbox,
  );
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../frontend/public/run-charts.js'), 'utf8'),
    sandbox,
  );
  return sandbox;
}

describe('shared run charts', () => {
  it('renders GC and ratio charts through BpwRunCharts', () => {
    const sandbox = loadCharts();
    sandbox.BpwRunCharts.setRunContext({ runId: 'demo-run' });

    const samples = [
      { Timestamp: 1000, Name: 'GradleDaemon', PID: '1', GCTime: 500, RSS: 100, HeapUsed: 40 },
      { Timestamp: 2000, Name: 'GradleDaemon', PID: '1', GCTime: 1500, RSS: 120, HeapUsed: 50 },
    ];

    sandbox.BpwRunCharts.renderGCChart(samples);
    sandbox.BpwRunCharts.renderRssHeapRatioChart(samples);

    const gcCall = sandbox.Plotly.newPlot.mock.calls.find((call: any[]) => call[0] === 'gc-chart');
    const ratioCall = sandbox.Plotly.newPlot.mock.calls.find((call: any[]) => call[0] === 'rss-heap-chart');
    expect(gcCall?.[2]?.uirevision).toBe('run:demo-run:panel:gc');
    expect(gcCall?.[1]?.[0]?.y).toEqual([0.5, 1.5]);
    expect(ratioCall?.[1]?.[0]?.y[0]).toBeCloseTo(0.4);
  });

  it('is loaded by both run dashboard pages', () => {
    for (const relative of ['runs/[runId].html', 'runs/demo.html']) {
      const html = fs.readFileSync(path.join(__dirname, '../frontend/public', relative), 'utf8');
      expect(html).toContain('<script src="/run-charts.js"></script>');
    }
    const dashboard = fs.readFileSync(path.join(__dirname, '../frontend/public/run-dashboard.js'), 'utf8');
    expect(dashboard).toContain('BpwRunCharts.renderGCChart');
  });
});
