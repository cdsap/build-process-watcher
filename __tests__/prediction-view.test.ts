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
    { process_name: 'GradleDaemon', pid: '1', metric: 'heap', created_at_ms: 1000, points: [{ target_at_ms: 2000, value_mb: 14 }, { target_at_ms: 20000, value_mb: 18 }] },
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
    expect(html).toContain('class="actual-trace"');
    expect(html).toContain('class="forecast-trace forecast-trace-latest"');
    expect(html).toContain('class="forecast-band"');
    expect(html).toContain('Elapsed time (seconds)');
    expect(html).toContain('Memory (MB)');
    expect(html.indexOf('Predicted</th>')).toBeLessThan(html.indexOf('Actual at target</th>'));
  });

  it('overlays predictions on the actual timeline and matches nearby sample times', () => {
    const nearSamples = [
      { Timestamp: 1000, Name: 'GradleDaemon', PID: '1', HeapUsed: 10, RSS: 20 },
      { Timestamp: 4500, Name: 'GradleDaemon', PID: '1', HeapUsed: 12, RSS: 22 },
      { Timestamp: 11000, Name: 'GradleDaemon', PID: '1', HeapUsed: 16, RSS: 26 },
    ];
    const nearForecasts = [
      {
        process_name: 'GradleDaemon',
        pid: '1',
        metric: 'heap',
        created_at_ms: 1000,
        points: [
          { target_at_ms: 11000, value_mb: 15 },
          { target_at_ms: 25000, value_mb: 20 },
        ],
      },
    ];
    const html = view.render({ samples: nearSamples, process_forecasts: nearForecasts }, null).html;
    expect(html).toContain('Replay scrubs actual and prediction tracks together');
    expect(html).toContain('id="forecast-replay-controls"');
    expect(html).toContain('class="forecast-chart"');
    expect(html).toContain('class="forecast-chart-legend"');
    expect(html).not.toContain('class="chart-legend"');
    expect(html).toContain('15.0 MB</td><td>16.0 MB');
    expect(html).toContain('20.0 MB</td><td>Pending');
    expect(view.actualNear(
      [{ time: 1000, value: 10 }, { time: 4500, value: 12 }],
      5000,
      10000,
    )).toEqual({ time: 4500, value: 12, delta: 500 });
  });

  it('binds prediction replay controls and scrubs chart frames', () => {
    const html = view.render({
      samples: [
        { Timestamp: 1000, Name: 'GradleDaemon', PID: '1', HeapUsed: 10, RSS: 20 },
        { Timestamp: 5000, Name: 'GradleDaemon', PID: '1', HeapUsed: 14, RSS: 24 },
        { Timestamp: 11000, Name: 'GradleDaemon', PID: '1', HeapUsed: 16, RSS: 26 },
      ],
      process_forecasts: [{
        process_name: 'GradleDaemon',
        pid: '1',
        metric: 'heap',
        created_at_ms: 1000,
        points: [
          { target_at_ms: 5000, value_mb: 13 },
          { target_at_ms: 11000, value_mb: 15 },
        ],
      }],
    }, null).html;

    const byId = new Map<string, any>();
    const hosts: any[] = [];
    const makeEl = (overrides: Record<string, any> = {}) => {
      const el: any = {
        value: '',
        textContent: '',
        __innerHTML: '',
        listeners: {} as Record<string, Function>,
        addEventListener: jest.fn((eventName: string, handler: Function) => {
          el.listeners[eventName] = handler;
        }),
        querySelector: (selector: string) => {
          const idMatch = selector.match(/^#(.+)$/);
          return idMatch ? byId.get(idMatch[1]) || null : null;
        },
        querySelectorAll: (selector: string) => (selector === '[data-forecast-chart-host]' ? hosts : []),
        ...overrides,
      };
      Object.defineProperty(el, 'innerHTML', {
        get: () => el.__innerHTML,
        set: (value: string) => { el.__innerHTML = String(value); },
      });
      return el;
    };

    const dataMatch = html.match(/id="bpw-forecast-replay-data">([\s\S]*?)<\/script>/);
    byId.set('bpw-forecast-replay-data', makeEl({ textContent: dataMatch?.[1] || '[]' }));
    byId.set('forecast-replay-timeline', makeEl({ value: '0' }));
    byId.set('forecast-replay-meta', makeEl());
    byId.set('forecast-replay-time-label', makeEl());
    byId.set('btn-forecast-replay-play', makeEl());
    byId.set('btn-forecast-replay-pause', makeEl());
    byId.set('btn-forecast-replay-reset', makeEl());
    byId.set('forecast-replay-speed', makeEl({ value: '15' }));
    hosts.push(makeEl());
    const controls = makeEl();
    byId.set('forecast-replay-controls', controls);
    const root = makeEl();
    root.querySelector = (selector: string) => {
      const idMatch = selector.match(/^#(.+)$/);
      return idMatch ? byId.get(idMatch[1]) || null : null;
    };

    const stop = view.bindProcessForecastReplay(root);
    const timeline = byId.get('forecast-replay-timeline');
    const meta = byId.get('forecast-replay-meta');
    expect(timeline).toBeTruthy();
    expect(meta.textContent).toContain('Frame 3 / 3');
    expect(hosts[0].innerHTML).toContain('class="actual-trace"');
    timeline.value = '0';
    timeline.listeners.input();
    expect(meta.textContent).toContain('Frame 1 / 3');
    expect(hosts[0].innerHTML).toContain('class="actual-trace"');
    stop();
  });

  it('ignores malformed data and leaves legacy and pending runs usable', () => {
    expect(() => view.render({ samples, process_forecasts: [{ process_name: 'GradleDaemon', pid: 1, metric: 'heap', created_at_ms: 1e20, points: [] }] }, null)).not.toThrow();
    expect(view.render({ samples }, null).html).not.toContain('Process memory forecasts');
    expect(view.render({ predictionEnabled: true }, null).html).toContain('Waiting for first checkpoint');
  });
});
