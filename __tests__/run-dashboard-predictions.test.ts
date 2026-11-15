import * as fs from 'fs';
import * as path from 'path';

const pages = [
  path.join(__dirname, '../frontend/public/runs/[runId].html'),
  path.join(__dirname, '../frontend/public/runs/demo.html'),
];

describe('run dashboard prediction evolution integration', () => {
  it.each(pages)('loads the shared prediction view and keeps both dashboard tabs: %s', (page) => {
    const source = fs.readFileSync(page, 'utf8');
    expect(source).toContain('<script src="/prediction-view.js"></script>');
    expect(source).toContain('data-run-tab="dashboard"');
    expect(source).toContain('data-run-tab="predictions"');
    expect(source).toContain('run-dashboard-tabs-legacy');
    expect(source).toContain('BpwPredictionView.render');
    expect(source).toContain('data-prediction-window');
    expect(source).toContain('data-prediction-chart-window');
    expect(source).toContain('Prediction checkpoints');
  });

  it('places Predictions in the Classic/Studio/Story mode switch', () => {
    const layout = fs.readFileSync(path.join(__dirname, '../frontend/public/experiment-layout.js'), 'utf8');
    expect(layout).toContain("predictions: 'predictions'");
    expect(layout).toContain('Predictions</span>');
    expect(layout).toContain('applyPredictionsView');
    expect(layout).toContain('bpw-view-predictions');
    expect(layout).toContain('setPredictionsEnabled');
    expect(layout).toContain('Not enabled');
  });

  it.each(pages)('wires prediction enablement into the mode switch: %s', (page) => {
    const source = fs.readFileSync(page, 'utf8');
    expect(source).toContain('BpwExperimentLayout.setPredictionsEnabled(predictionEnabled)');
  });

  it.each(pages)('preserves marker-to-checkpoint selection wiring: %s', (page) => {
    const source = fs.readFileSync(page, 'utf8');
    expect(source).toContain('BpwPredictionView.buildMarkerData(predictionCheckpoints, chartTimestamps)');
    expect(source).toContain('predictionSelectedWindow = Number(marker.customdata)');
    expect(source).toContain('focusPredictionOnChart');
    expect(source).toContain('renderPredictionPanel(window.currentRunData, predictionSelectedWindow)');
    expect(source).not.toContain('renderDashboard(runId, data);\n                    setRunDashboardTab(\'predictions\')');
    expect(source).toContain("['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']");
    expect(source).not.toContain('const buildPredictionMarkerData =');
  });

  it('keeps legacy runs without prediction checkpoints valid', () => {
    const source = fs.readFileSync(pages[0], 'utf8');
    expect(source).toContain('prediction-view.js');
    expect(source).toContain('BpwPredictionView.normalizeCheckpoints(data.prediction_checkpoints)');
    expect(source).toContain('predictionEnabled');
  });

  it('binds process forecast replay after the finished dashboard render', () => {
    const source = fs.readFileSync(pages[0], 'utf8');
    expect(source).toContain('bindForecastReplayControls');
    expect(source).toContain('BpwPredictionView.bindProcessForecastView');
    expect(source).toContain('shouldKeepPollingRun');
    expect(source).toContain('canUpdateFinishedPredictionPanel');
    expect(source).toContain('POST_FINISH_FORECAST_GRACE_MS');
  });

  it.each(pages)('patches live timeline forecasts without remounting controls: %s', (page) => {
    const source = fs.readFileSync(page, 'utf8');
    expect(source).toContain('forecastViewController.update');
    expect(source).toContain('bindForecastViewControls');
    expect(source).toContain("predictionMode === 'bqml-boosted'");
  });
});

describe('demo run dashboard parity', () => {
  const requiredScripts = [
    '/playback-clock.js',
    '/chart-viewport.js',
    '/chart-series-store.js',
    '/live-run-controller.js',
    '/prediction-view.js',
    '/freshness-view.js',
  ];

  it('loads the same supporting modules as the live run dashboard', () => {
    const demo = fs.readFileSync(pages[1], 'utf8');
    const run = fs.readFileSync(pages[0], 'utf8');
    for (const script of requiredScripts) {
      expect(demo).toContain(`<script src="${script}"></script>`);
      expect(run).toContain(`<script src="${script}"></script>`);
    }
  });

  it('keeps demo initReplay and renderChart aligned with the live run page', () => {
    const demo = fs.readFileSync(pages[1], 'utf8');
    const run = fs.readFileSync(pages[0], 'utf8');

    function extractFn(source: string, name: string): string {
      const start = source.search(new RegExp(`function\\s+${name}\\s*\\(`));
      if (start < 0) throw new Error(`${name} missing`);
      let paramsDepth = 0;
      let i = source.indexOf('(', start);
      for (; i < source.length; i += 1) {
        if (source[i] === '(') paramsDepth += 1;
        else if (source[i] === ')') {
          paramsDepth -= 1;
          if (paramsDepth === 0) break;
        }
      }
      let bodyStart = i + 1;
      while (bodyStart < source.length && /\s/.test(source[bodyStart])) bodyStart += 1;
      let depth = 0;
      for (let end = bodyStart; end < source.length; end += 1) {
        if (source[end] === '{') depth += 1;
        else if (source[end] === '}') {
          depth -= 1;
          if (depth === 0) return source.slice(start, end + 1);
        }
      }
      throw new Error(`${name} body not closed`);
    }

    expect(extractFn(demo, 'initReplay')).toBe(extractFn(run, 'initReplay'));
    expect(extractFn(demo, 'renderChart')).toBe(extractFn(run, 'renderChart'));
    expect(demo).toContain('function ensureChartResizeHandler');
    expect(demo).toContain('BpwPlaybackClock.createPlaybackClock');
    expect(demo).toContain('BpwChartViewport');
  });
});

