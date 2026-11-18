import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

function loadView(): any {
  const sandbox: any = {
    module: { exports: {} },
    exports: {},
    performance: { now: () => 0 },
    setTimeout,
    clearTimeout,
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (cb: Function) => setTimeout(() => cb(0), 0),
    cancelAnimationFrame: clearTimeout,
    document: { querySelector: () => null },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../frontend/public/playback-clock.js'), 'utf8'),
    sandbox,
  );
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../frontend/public/replay-controls.js'), 'utf8'),
    sandbox,
  );
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../frontend/public/prediction-view.js'), 'utf8'),
    sandbox,
  );
  return sandbox.BpwPredictionView;
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
    // Checkpoint panels are retired; render ignores stored checkpoints.
    expect(view.render({ prediction_checkpoints: checkpoints }, null).selectedWindow).toBeNull();
    expect(view.render({ prediction_checkpoints: checkpoints }, 120).selectedWindow).toBeNull();
  });

  it('does not render retired reliability checkpoint panels', () => {
    const rendered = view.render({ prediction_checkpoints: [{ observation_window_s: 60, status: 'ready' }] }, null).html;
    expect(rendered).not.toContain('Latest prediction');
    expect(rendered).not.toContain('Checkpoint details');
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

  it('returns empty marker overlays after reliability retirement', () => {
    const markers = view.buildMarkerData([
      { observation_window_s: 60, status: 'ready', risk_level: 'high' },
    ], [0, 60_000]);
    expect(markers).toEqual({ shapes: [], annotations: [], traces: [] });
  });


  it('supports elapsed axes by returning empty overlays', () => {
    expect(view.buildMarkerData([{ observation_window_s: 60, status: 'ready' }], [0, 60], { axis: 'elapsed' }))
      .toEqual({ shapes: [], annotations: [], traces: [] });
    expect(view.buildMarkerData(null, [0, 60])).toEqual({ shapes: [], annotations: [], traces: [] });
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
    expect(html).toContain('class="actual-trace"');
    expect(html).toContain('class="forecast-trace forecast-trace-latest"');
    expect(html).toContain('class="forecast-band"');
    expect(html).toContain('Elapsed time (seconds)');
    expect(html).toContain('Memory (MB)');
    expect(html).toContain('viewBox="0 0 960 280"');
    expect(html).not.toContain('process-forecast-tables');
    expect(html).not.toContain('Predicted</th>');
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
    expect(html).toContain('Live follows the latest sample');
    expect(html).toContain('Each orange point marks when a forecast was issued');
    expect(html).toContain('id="forecast-replay-controls"');
    expect(html).toContain('id="btn-forecast-view-live"');
    expect(html).toContain('id="btn-forecast-view-replay"');
    expect(html).toContain('id="forecast-live-status"');
    expect(html).toContain('class="forecast-chart"');
    expect(html).toContain('class="forecast-chart-legend"');
    expect(html).toContain('legend-issuance');
    expect(html).toContain('class="forecast-point forecast-issuance"');
    expect(html).toContain('Issuance at 0s');
    expect(html).toContain('class="process-forecast-charts"');
    expect(html).not.toContain('process-forecast-tables');
    expect(html).not.toContain('forecast-table-scroll');
    expect(html).not.toContain('class="chart-legend"');
    expect(html).toContain('data-forecast-chart-host');
    expect(view.actualNear(
      [{ time: 1000, value: 10 }, { time: 4500, value: 12 }],
      5000,
      10000,
    )).toEqual({ time: 4500, value: 12, delta: 500 });
  });

  it('draws one issuance marker per process_forecast created_at', () => {
    const samples = [
      { Timestamp: 0, Name: 'GradleDaemon', PID: '1', HeapUsed: 10, RSS: 20 },
      { Timestamp: 10000, Name: 'GradleDaemon', PID: '1', HeapUsed: 12, RSS: 22 },
      { Timestamp: 20000, Name: 'GradleDaemon', PID: '1', HeapUsed: 14, RSS: 24 },
    ];
    const forecasts = [
      {
        process_name: 'GradleDaemon',
        pid: '1',
        metric: 'heap',
        created_at_ms: 0,
        points: [{ target_at_ms: 10000, value_mb: 11 }],
      },
      {
        process_name: 'GradleDaemon',
        pid: '1',
        metric: 'heap',
        created_at_ms: 10000,
        points: [{ target_at_ms: 20000, value_mb: 13 }],
      },
    ];
    const html = view.render({ samples, process_forecasts: forecasts, prediction_mode: 'predict' }, null).html;
    const markers = html.match(/class="forecast-point forecast-issuance"/g) || [];
    expect(markers).toHaveLength(2);
    expect(html).toContain('Issuance at 0s');
    expect(html).toContain('Issuance at 10s');
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
        dataset: {},
        classList: { toggle: jest.fn() },
        setAttribute: jest.fn(),
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
    byId.set('btn-forecast-view-live', makeEl());
    byId.set('btn-forecast-view-replay', makeEl());
    byId.set('forecast-live-status', makeEl());
    hosts.push(makeEl());
    const controls = makeEl({ dataset: { forecastViewMode: 'live' }, classList: { toggle: jest.fn() } });
    byId.set('forecast-replay-controls', controls);
    const root = makeEl();
    root.querySelector = (selector: string) => {
      const idMatch = selector.match(/^#(.+)$/);
      return idMatch ? byId.get(idMatch[1]) || null : null;
    };
    root.querySelectorAll = (selector: string) => (selector === '[data-forecast-chart-host]' ? hosts : []);

    const controller = view.bindProcessForecastView(root, { initialMode: 'live' });
    const timeline = byId.get('forecast-replay-timeline');
    const meta = byId.get('forecast-replay-meta');
    expect(timeline).toBeTruthy();
    expect(controller.getMode()).toBe('live');
    expect(meta.textContent).toContain('Live · sample 3 / 3');
    expect(hosts[0].innerHTML).toContain('class="actual-trace"');
    timeline.value = '0';
    timeline.listeners.input();
    expect(controller.getMode()).toBe('replay');
    expect(meta.textContent).toContain('Frame 1 / 3');
    expect(hosts[0].innerHTML).toContain('class="actual-trace"');
    controller.stop();
  });

  it('keeps actual charts while waiting for laggy timeline forecasts', () => {
    const html = view.render({
      prediction_mode: 'predict',
      finished: false,
      samples: [
        { Timestamp: 1000, Name: 'GradleDaemon', PID: '1', HeapUsed: 10, RSS: 20 },
        { Timestamp: 5000, Name: 'GradleDaemon', PID: '1', HeapUsed: 14, RSS: 24 },
      ],
      process_forecasts: [],
    }, null).html;
    expect(html).toContain('waiting for first forecast');
    expect(html).toContain('btn-forecast-view-live');
    expect(html).toContain('class="actual-trace"');
  });

  it('reports forecast lag for delayed predict issuances', () => {
    const status = view.formatForecastStatus({
      prediction_mode: 'predict',
      samples: [{ Timestamp: 60000, Name: 'GradleDaemon', PID: '1', HeapUsed: 10, RSS: 20 }],
      process_forecasts: [{
        process_name: 'GradleDaemon',
        pid: '1',
        metric: 'heap',
        created_at_ms: 10000,
        method: 'last_value',
        points: [{ target_at_ms: 20000, value_mb: 12 }],
      }],
    }, 'live');
    expect(status).toContain('Live · predict');
    expect(status).toContain('forecast 50s behind samples');
    expect(status).toContain('last_value');
  });

  it('forces Replay for finished runs even when Live was sticky from the live session', () => {
    const sandboxView = loadView();
    const sandboxWindow = (sandboxView as any);
    // preferredForecastViewMode reads window.__bpwForecastViewMode from the VM sandbox.
    const html = (() => {
      const ctx: any = {
        module: { exports: {} },
        exports: {},
        performance: { now: () => 0 },
        setTimeout,
        clearTimeout,
        matchMedia: () => ({ matches: false }),
        requestAnimationFrame: (cb: Function) => setTimeout(() => cb(0), 0),
        cancelAnimationFrame: clearTimeout,
        document: { querySelector: () => null },
        __bpwForecastViewMode: 'live',
      };
      ctx.globalThis = ctx;
      ctx.window = ctx;
      vm.runInNewContext(
        fs.readFileSync(path.join(__dirname, '../frontend/public/prediction-view.js'), 'utf8'),
        ctx,
      );
      expect(ctx.BpwPredictionView.preferredForecastViewMode({ finished: true })).toBe('replay');
      expect(ctx.BpwPredictionView.preferredForecastViewMode({ finished: false })).toBe('live');
      return ctx.BpwPredictionView.render({
        finished: true,
        prediction_mode: 'bqml-boosted',
        samples: [
          { Timestamp: 1000, Name: 'GradleDaemon', PID: '1', HeapUsed: 10, RSS: 20 },
          { Timestamp: 5000, Name: 'GradleDaemon', PID: '1', HeapUsed: 14, RSS: 24 },
        ],
        process_forecasts: [{
          process_name: 'GradleDaemon',
          pid: '1',
          metric: 'heap',
          created_at_ms: 1000,
          method: 'last_value',
          model_version: 'bqml-boosted-last-value-v1',
          points: [{ target_at_ms: 5000, value_mb: 13 }],
        }],
      }, null).html;
    })();

    expect(html).toContain('data-forecast-view-mode="replay"');
    expect(html).toContain('aria-pressed="true">Replay</button>');
    expect(html).toContain('Replay · bqml-boosted');
    expect(sandboxView).toBeTruthy();
  });

  it('treats tabpfn as a timeline prediction mode', () => {
    expect(view.isTimelinePredictionMode('tabpfn')).toBe(true);
    const html = view.render({
      prediction_mode: 'tabpfn',
      samples: [
        { Timestamp: 1000, Name: 'GradleDaemon', PID: '1', HeapUsed: 10, RSS: 20 },
        { Timestamp: 5000, Name: 'GradleDaemon', PID: '1', HeapUsed: 14, RSS: 24 },
      ],
      process_forecasts: [{
        process_name: 'GradleDaemon',
        pid: '1',
        metric: 'heap',
        created_at_ms: 1000,
        method: 'tabpfn',
        model_version: 'tabpfn-timeline-v1',
        points: [{ target_at_ms: 5000, value_mb: 13 }],
      }],
    }, null).html;
    expect(html).toContain('data-prediction-mode="tabpfn"');
    expect(html).toContain('tabpfn');
  });

  it('flips Live to Replay when an in-place update marks the run finished', () => {
    const ctx: any = {
      module: { exports: {} },
      exports: {},
      performance: { now: () => 0 },
      setTimeout,
      clearTimeout,
      matchMedia: () => ({ matches: false }),
      requestAnimationFrame: (cb: Function) => setTimeout(() => cb(0), 0),
      cancelAnimationFrame: clearTimeout,
      document: { querySelector: () => null },
      __bpwForecastViewMode: 'live',
    };
    ctx.globalThis = ctx;
    ctx.window = ctx;
    vm.runInNewContext(
      fs.readFileSync(path.join(__dirname, '../frontend/public/prediction-view.js'), 'utf8'),
      ctx,
    );
    const localView = ctx.BpwPredictionView;
    const liveData = {
      finished: false,
      prediction_mode: 'bqml-boosted',
      samples: [
        { Timestamp: 1000, Name: 'GradleDaemon', PID: '1', HeapUsed: 10, RSS: 20 },
        { Timestamp: 5000, Name: 'GradleDaemon', PID: '1', HeapUsed: 14, RSS: 24 },
        { Timestamp: 9000, Name: 'GradleDaemon', PID: '1', HeapUsed: 16, RSS: 26 },
      ],
      process_forecasts: [{
        process_name: 'GradleDaemon',
        pid: '1',
        metric: 'heap',
        created_at_ms: 1000,
        method: 'last_value',
        points: [
          { target_at_ms: 5000, value_mb: 13 },
          { target_at_ms: 9000, value_mb: 15 },
        ],
      }],
    };
    const html = localView.render(liveData, null).html;
    const byId = new Map<string, any>();
    const hosts: any[] = [];
    const makeEl = (overrides: Record<string, any> = {}) => {
      const el: any = {
        value: '',
        textContent: '',
        __innerHTML: '',
        listeners: {} as Record<string, Function>,
        dataset: {},
        classList: { toggle: jest.fn() },
        setAttribute: jest.fn(),
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
    byId.set('btn-forecast-view-live', makeEl());
    byId.set('btn-forecast-view-replay', makeEl());
    byId.set('forecast-live-status', makeEl());
    hosts.push(makeEl());
    byId.set('forecast-replay-controls', makeEl({ dataset: { forecastViewMode: 'live' }, classList: { toggle: jest.fn() } }));
    const root = makeEl();
    root.querySelector = (selector: string) => {
      const idMatch = selector.match(/^#(.+)$/);
      return idMatch ? byId.get(idMatch[1]) || null : null;
    };
    root.querySelectorAll = (selector: string) => (selector === '[data-forecast-chart-host]' ? hosts : []);

    const controller = localView.bindProcessForecastView(root, { initialMode: 'live', data: liveData });
    expect(controller.getMode()).toBe('live');
    expect(controller.update({ ...liveData, finished: true })).toBe(true);
    expect(controller.getMode()).toBe('replay');
    expect(ctx.__bpwForecastViewMode).toBe('replay');
    controller.stop();
  });

  it('ignores malformed data and leaves legacy and pending runs usable', () => {
    expect(() => view.render({ samples, process_forecasts: [{ process_name: 'GradleDaemon', pid: 1, metric: 'heap', created_at_ms: 1e20, points: [] }] }, null)).not.toThrow();
    expect(view.render({ samples }, null).html).not.toContain('Process memory forecasts');
    expect(view.render({ predictionEnabled: true }, null).html).not.toContain('Waiting for first checkpoint');
  });

  it('has no local setTimeout frame scheduler for forecast playback', () => {
    const source = fs.readFileSync(path.join(__dirname, '../frontend/public/prediction-view.js'), 'utf8');
    expect(source).toContain('createPlaybackClock');
    expect(source).not.toMatch(/playTimer\s*=\s*setTimeout/);
    expect(source).not.toContain('playTimer');
  });

  it('drives forecast replay with BpwPlaybackClock play/pause/reset/speed lifecycle', () => {
    const sandbox: any = {
      module: { exports: {} },
      exports: {},
      performance: { now: () => sandbox.__now },
      setTimeout,
      clearTimeout,
      matchMedia: () => ({ matches: false }),
      requestAnimationFrame: (cb: Function) => {
        sandbox.__raf = cb;
        return 1;
      },
      cancelAnimationFrame: () => { sandbox.__raf = null; },
      document: { querySelector: () => null },
      __now: 0,
      __raf: null as null | Function,
    };
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    vm.runInNewContext(
      fs.readFileSync(path.join(__dirname, '../frontend/public/playback-clock.js'), 'utf8'),
      sandbox,
    );
    vm.runInNewContext(
      fs.readFileSync(path.join(__dirname, '../frontend/public/replay-controls.js'), 'utf8'),
      sandbox,
    );
    vm.runInNewContext(
      fs.readFileSync(path.join(__dirname, '../frontend/public/prediction-view.js'), 'utf8'),
      sandbox,
    );
    const view = sandbox.BpwPredictionView;

    const html = view.render({
      prediction_mode: 'forecast',
      finished: false,
      samples: [
        { Timestamp: 1000, Name: 'GradleDaemon', PID: '1', HeapUsed: 10, RSS: 20 },
        { Timestamp: 6000, Name: 'GradleDaemon', PID: '1', HeapUsed: 12, RSS: 22 },
        { Timestamp: 11000, Name: 'GradleDaemon', PID: '1', HeapUsed: 14, RSS: 24 },
      ],
      process_forecasts: [{
        process_name: 'GradleDaemon',
        pid: '1',
        metric: 'rss',
        created_at_ms: 1000,
        points: [{ target_at_ms: 16000, value_mb: 30 }],
      }],
    }, null).html;

    const byId = new Map<string, any>();
    const hosts: any[] = [];
    const makeEl = (overrides: any = {}) => {
      const el: any = {
        __innerHTML: '',
        textContent: '',
        value: '0',
        classList: { toggle: jest.fn() },
        dataset: {},
        listeners: {} as Record<string, Function>,
        setAttribute: jest.fn(),
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
    const playBtn = makeEl();
    const pauseBtn = makeEl();
    const resetBtn = makeEl();
    const speedSelect = makeEl({ value: '5' });
    byId.set('btn-forecast-replay-play', playBtn);
    byId.set('btn-forecast-replay-pause', pauseBtn);
    byId.set('btn-forecast-replay-reset', resetBtn);
    byId.set('forecast-replay-speed', speedSelect);
    byId.set('btn-forecast-view-live', makeEl());
    byId.set('btn-forecast-view-replay', makeEl());
    byId.set('forecast-live-status', makeEl());
    hosts.push(makeEl());
    byId.set('forecast-replay-controls', makeEl({
      dataset: { forecastViewMode: 'replay' },
      classList: { toggle: jest.fn() },
    }));
    const root = makeEl();
    root.querySelector = (selector: string) => {
      const idMatch = selector.match(/^#(.+)$/);
      return idMatch ? byId.get(idMatch[1]) || null : null;
    };
    root.querySelectorAll = (selector: string) => (selector === '[data-forecast-chart-host]' ? hosts : []);

    const createSpy = jest.spyOn(sandbox.BpwPlaybackClock, 'createPlaybackClock');
    const controller = view.bindProcessForecastView(root, { initialMode: 'replay' });
    expect(controller.getMode()).toBe('replay');

    playBtn.listeners.click();
    expect(createSpy).toHaveBeenCalled();
    const clock = createSpy.mock.results[0].value;
    expect(clock.getState().playing).toBe(true);

    sandbox.__now = 200; // 0.2s wall * 5x => 1s logical; sample spacing is 5s so still frame 0
    sandbox.__raf(sandbox.__now);
    expect(byId.get('forecast-replay-meta').textContent).toContain('Frame');

    pauseBtn.listeners.click();
    expect(clock.getState().playing).toBe(false);

    speedSelect.value = '50';
    speedSelect.listeners.change();
    expect(clock.getState().speed).toBe(50);

    resetBtn.listeners.click();
    expect(clock.getState().cursorMs).toBe(0);
    expect(clock.getState().playing).toBe(false);

    // Live update while unfinished then finish should sticky-flip to Replay.
    controller.setMode('live');
    expect(controller.getMode()).toBe('live');
    controller.update({
      prediction_mode: 'forecast',
      finished: true,
      samples: [
        { Timestamp: 1000, Name: 'GradleDaemon', PID: '1', HeapUsed: 10, RSS: 20 },
        { Timestamp: 6000, Name: 'GradleDaemon', PID: '1', HeapUsed: 12, RSS: 22 },
        { Timestamp: 11000, Name: 'GradleDaemon', PID: '1', HeapUsed: 14, RSS: 24 },
      ],
      process_forecasts: [{
        process_name: 'GradleDaemon',
        pid: '1',
        metric: 'rss',
        created_at_ms: 1000,
        points: [{ target_at_ms: 16000, value_mb: 30 }],
      }],
    });
    expect(controller.getMode()).toBe('replay');

    const destroySpy = jest.spyOn(clock, 'destroy');
    // Recreate clock for stop coverage after update may have rebuilt it.
    playBtn.listeners.click();
    const activeClock = createSpy.mock.results[createSpy.mock.results.length - 1].value;
    const activeDestroy = jest.spyOn(activeClock, 'destroy');
    controller.stop();
    expect(activeDestroy).toHaveBeenCalled();
    createSpy.mockRestore();
  });

});
