import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

function loadView(): any {
  const window: any = {};
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../frontend/public/prediction-view.js'), 'utf8'),
    { window },
  );
  return window.BpwPredictionView;
}

describe('prediction view model', () => {
  const view = loadView();

  it('normalizes optional, invalid, duplicate, and unordered checkpoints', () => {
    const input = [
      { observation_window_s: 180, status: 'ready' },
      { observation_window_s: 'bad', status: 'ready' },
      { observation_window_s: 60, status: 'pending' },
      { observation_window_s: 60, status: 'ready', risk_level: 'low' },
      { observation_window_s: null, status: 'error' },
    ];

    expect(view.normalizeCheckpoints(input)).toEqual([
      { observation_window_s: 60, status: 'ready', risk_level: 'low' },
      { observation_window_s: 180, status: 'ready' },
    ]);
    expect(input[0].observation_window_s).toBe(180);
  });

  it('selects latest ready and falls back to newest stored checkpoint', () => {
    const checkpoints = view.normalizeCheckpoints([
      { observation_window_s: 60, status: 'ready' },
      { observation_window_s: 120, status: 'error' },
    ]);
    expect(view.render({ prediction_checkpoints: checkpoints }, null).selectedWindow).toBe(60);
    expect(view.render({ prediction_checkpoints: checkpoints }, 120).selectedWindow).toBe(120);
    expect(view.render({ prediction_checkpoints: [{ observation_window_s: 60, status: 'pending' }] }, null).selectedWindow).toBe(60);
  });

  it('renders unavailable values without converting them to zero', () => {
    const rendered = view.render({ prediction_checkpoints: [{ observation_window_s: 60, status: 'ready' }] }, null).html;
    expect(rendered).toContain('Not available');
    expect(rendered).not.toContain('0 MB');
  });

  it('aligns observed RSS to the latest sample at or before the checkpoint', () => {
    const observed = view.observedAtCheckpoint([
      { Timestamp: 1000, RSS: 10 },
      { Timestamp: 30000, RSS: 20 },
      { Timestamp: 70000, RSS: 40 },
    ], { observation_window_s: 60 });
    expect(observed).toEqual({ timestamp: 30000, rss: 20 });
  });
});
