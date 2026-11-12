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
      { Timestamp: 1000, RSS: 10, Name: 'GradleDaemon', PID: 1 },
      { Timestamp: 1000, RSS: 20, Name: 'KotlinCompileDaemon', PID: 2 },
      { Timestamp: 30000, RSS: 20, Name: 'GradleDaemon', PID: 1 },
      { Timestamp: 70000, RSS: 40, Name: 'GradleDaemon', PID: 1 },
    ], { observation_window_s: 60 });
    expect(observed).toEqual({ timestamp: 30000, rss: 40 });
  });

  it('forward-fills processes when calculating aggregate peak RSS', () => {
    expect(view.peakAggregateRss([
      { Timestamp: 1000, RSS: 10, Name: 'GradleDaemon', PID: 1 },
      { Timestamp: 1000, RSS: 20, Name: 'KotlinCompileDaemon', PID: 2 },
      { Timestamp: 2000, RSS: 15, Name: 'GradleDaemon', PID: 1 },
      { Timestamp: 3000, RSS: 25, Name: 'KotlinCompileDaemon', PID: 2 },
    ])).toBe(40);
  });

  it('builds timestamp-axis prediction markers with status and risk details', () => {
    const markers = view.buildMarkerData([
      {
        observation_window_s: 60,
        status: 'ready',
        risk_level: 'high',
        confidence: 'medium',
        predicted_peak_rss_mb: 512,
        predicted_duration_s: 180,
        signals: ['heap pressure', '<unsafe>'],
      },
      { observation_window_s: 120, status: 'pending' },
    ], [1000, 121000]);

    expect(markers.traces).toHaveLength(1);
    expect(markers.traces[0].x).toEqual([new Date(61000), new Date(121000)]);
    expect(markers.traces[0].customdata).toEqual([60, 120]);
    expect(markers.traces[0].marker.color).toEqual(['#dc2626', '#94a3b8']);
    expect(markers.traces[0].text[0]).toContain('Predicted peak RSS: 512.0 MB');
    expect(markers.traces[0].text[0]).toContain('Top signals: heap pressure, &lt;unsafe&gt;');
    expect(markers.annotations.map((annotation: any) => annotation.text)).toEqual(['P 60s', 'pending 120s']);
  });

  it('supports elapsed axes and ignores unusable marker input', () => {
    expect(view.buildMarkerData([], [1000])).toEqual({ shapes: [], annotations: [], traces: [] });
    expect(view.buildMarkerData([{ observation_window_s: 'bad' }], [1000])).toEqual({ shapes: [], annotations: [], traces: [] });

    const markers = view.buildMarkerData(
      [{ observation_window_s: 60, status: 'ready', risk_level: 'low' }],
      [1000],
      { axisMode: 'elapsed' },
    );
    expect(markers.traces[0].x).toEqual([60]);
    expect(markers.shapes[0]).toEqual(expect.objectContaining({ x0: 60, x1: 60 }));
  });
});

describe('per-process memory forecasts', () => {
  const view = loadView();
  const samples = [
    { Timestamp: 1000, Name: 'GradleDaemon', PID: '1', HeapUsed: 10, RSS: 20 },
    { Timestamp: 2000, Name: 'GradleDaemon', PID: '1', HeapUsed: 15, RSS: 25 },
    { Timestamp: 1000, Name: 'KotlinCompileDaemon', PID: '2', RSS: 30 },
    { Timestamp: 1000, Name: 'Other', PID: '3', RSS: 40 },
  ];
  const process_forecasts = [
    { process_name: 'GradleDaemon', pid: '1', metric: 'heap', created_at_ms: 1000, points: [{ target_at_ms: 2000, value_mb: 14 }, { target_at_ms: 3000, value_mb: 18 }] },
    { process_name: 'GradleDaemon', pid: '1', metric: 'heap', created_at_ms: 1500, points: [{ target_at_ms: 2000, value_mb: 16 }] },
    { process_name: 'KotlinCompileDaemon', pid: '2', metric: 'rss', created_at_ms: 1000, points: [{ target_at_ms: 2000, value_mb: 31 }] },
    { process_name: 'KotlinCompileDaemon', pid: '2', metric: 'heap', created_at_ms: 1000, points: [{ target_at_ms: 2000, value_mb: 5 }] },
    { process_name: 'Other', pid: '3', metric: 'rss', created_at_ms: 1000, points: [{ target_at_ms: 2000, value_mb: 42 }] },
  ];

  it('retains forecasts for observed process metrics and matches exact actual times', () => {
    const html = view.render({ samples, process_forecasts }, null).html;
    expect(html).toContain('GradleDaemon · PID 1 · Heap');
    expect(html).toContain('KotlinCompileDaemon · PID 2 · RSS');
    expect(html).not.toContain('KotlinCompileDaemon · PID 2 · Heap');
    expect(html).not.toContain('Other · PID');
    expect(html).toContain('14.0 MB</td><td>15.0 MB');
    expect(html).toContain('16.0 MB</td><td>15.0 MB');
    expect(html).toContain('18.0 MB</td><td>Pending');
    expect(html.indexOf('Predicted</th>')).toBeLessThan(html.indexOf('Actual at target</th>'));
  });

  it('ignores malformed data and leaves legacy and pending runs usable', () => {
    expect(() => view.render({ samples, process_forecasts: [{ process_name: 'GradleDaemon', pid: 1, metric: 'heap', created_at_ms: 1e20, points: [] }] }, null)).not.toThrow();
    expect(view.render({ samples }, null).html).not.toContain('Process memory forecasts');
    expect(view.render({ predictionEnabled: true }, null).html).toContain('Waiting for first checkpoint');
  });
});
