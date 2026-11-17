import * as fs from 'fs';
import * as path from 'path';

const pages = [
  path.join(__dirname, '../frontend/public/runs/[runId].html'),
  path.join(__dirname, '../frontend/public/runs/demo.html'),
];
const sharedDashboard = fs.readFileSync(
  path.join(__dirname, '../frontend/public/run-dashboard.js'),
  'utf8',
);

function readDashboardPage(page: string): string {
  return `${fs.readFileSync(page, 'utf8')}\n${sharedDashboard}`;
}

describe('run dashboard prediction evolution integration', () => {
  it.each(pages)('loads the shared prediction view without legacy dashboard tabs: %s', (page) => {
    const source = readDashboardPage(page);
    expect(source).toContain('<script src="/prediction-view.js"></script>');
    expect(source).not.toContain('prediction-preview');
    expect(source).not.toContain('data-open-predictions');
    expect(source).not.toContain('Open Predictions');
    expect(source).not.toContain('data-run-tab');
    expect(source).not.toContain('run-dashboard-tabs-legacy');
    expect(source).not.toContain('activeRunDashboardTab');
    expect(source).not.toContain('setRunDashboardTab');
    expect(source).not.toContain('bindRunDashboardTabs');
    expect(source).not.toContain('aria-labelledby="run-tab-');
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
    const source = readDashboardPage(page);
    expect(source).toContain('BpwExperimentLayout.setPredictionsEnabled(predictionEnabled)');
  });

  it.each(pages)('preserves marker-to-checkpoint selection wiring: %s', (page) => {
    const source = readDashboardPage(page);
    expect(source).toContain('BpwPredictionView.buildMarkerData(predictionCheckpoints, chartTimestamps)');
    expect(source).toContain('predictionSelectedWindow = Number(marker.customdata)');
    expect(source).toContain('focusPredictionOnChart');
    expect(source).toContain('renderPredictionPanel(window.currentRunData, predictionSelectedWindow)');
    expect(source).toContain("['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']");
    expect(source).not.toContain('const buildPredictionMarkerData =');
  });

  it('keeps legacy runs without prediction checkpoints valid', () => {
    const source = readDashboardPage(pages[0]);
    expect(source).toContain('prediction-view.js');
    expect(source).toContain('BpwPredictionView.normalizeCheckpoints(data.prediction_checkpoints)');
    expect(source).toContain('predictionEnabled');
  });

  it('binds process forecast replay after the finished dashboard render', () => {
    const source = readDashboardPage(pages[0]);
    expect(source).toContain('bindForecastReplayControls');
    expect(source).toContain('BpwPredictionView.bindProcessForecastReplay');
    expect(source).toContain("initialMode: data?.finished === true ? 'replay' : undefined");
    expect(source).toContain('shouldKeepPollingRun');
    expect(source).toContain('canUpdateFinishedPredictionPanel');
    expect(source).toContain('POST_FINISH_FORECAST_GRACE_MS');
  });
});
