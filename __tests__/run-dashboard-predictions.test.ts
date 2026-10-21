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
    expect(source).toContain('BpwPredictionView.render');
    expect(source).toContain('data-prediction-window');
    expect(source).toContain('data-prediction-chart-window');
    expect(source).toContain('Prediction checkpoints');
  });

  it.each(pages)('preserves marker-to-checkpoint selection wiring: %s', (page) => {
    const source = fs.readFileSync(page, 'utf8');
    expect(source).toContain('customdata: markers.map(marker => marker.windowSeconds)');
    expect(source).toContain('predictionSelectedWindow = Number(marker.customdata)');
    expect(source).toContain('focusPredictionOnChart');
    expect(source).toContain('renderPredictionPanel(window.currentRunData, predictionSelectedWindow)');
    expect(source).not.toContain('renderDashboard(runId, data);\n                    setRunDashboardTab(\'predictions\')');
    expect(source).toContain("['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']");
  });

  it('keeps legacy runs without prediction checkpoints valid', () => {
    const source = fs.readFileSync(pages[0], 'utf8');
    expect(source).toContain('prediction-view.js');
    expect(source).toContain('BpwPredictionView.normalizeCheckpoints(data.prediction_checkpoints)');
    expect(source).toContain('predictionEnabled');
  });
});
