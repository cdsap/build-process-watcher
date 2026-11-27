import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

function loadShared(overrides: Record<string, any> = {}): any {
  const window: any = { innerWidth: 1200 };
  const context = vm.createContext({
    window,
    globalThis: window,
    document: overrides.document || { querySelector: () => null },
    localStorage: { getItem: () => null },
    performance: { now: () => 0 },
    setTimeout,
    clearTimeout,
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (cb: Function) => setTimeout(() => cb(0), 0),
    cancelAnimationFrame: clearTimeout,
    ...overrides,
  });
  context.window = window;
  context.globalThis = window;
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../frontend/public/playback-clock.js'), 'utf8'),
    context,
  );
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '../frontend/public/replay-controls.js'), 'utf8'),
    context,
  );
  window.BpwPlaybackClock = context.BpwPlaybackClock || window.BpwPlaybackClock;
  window.BpwReplayControls = context.BpwReplayControls || window.BpwReplayControls;
  const source = fs.readFileSync(path.join(__dirname, '../frontend/public/compare-shared.js'), 'utf8');
  vm.runInContext(source, context);
  return window.BpwCompareShared;
}

function createFakeDocument() {
  const elements = new Map<string, any>();
  const registerElement = (id: string) => {
    if (!elements.has(id)) {
      const element: any = {
        id,
        style: {},
        checked: true,
        value: id === 'compare-replay-speed' ? '15' : '',
        max: '',
        textContent: '',
        data: [],
        listeners: {},
        addEventListener: jest.fn((eventName: string, handler: Function) => {
          element.listeners[eventName] = handler;
        }),
        appendChild: jest.fn(),
        on: jest.fn(),
        querySelector: (selector: string) => {
          const idMatch = String(selector).match(/^#(.+)$/);
          return idMatch ? elements.get(idMatch[1]) || null : null;
        },
        querySelectorAll: () => [],
      };
      Object.defineProperty(element, 'innerHTML', {
        get: () => element.__innerHTML || '',
        set: (value: string) => {
          element.__innerHTML = value;
          for (const match of value.matchAll(/id="([^"]+)"/g)) {
            registerElement(match[1]);
          }
        },
      });
      elements.set(id, element);
    }
    return elements.get(id);
  };

  return {
    registerElement,
    getElementById: jest.fn((id: string) => elements.get(id) || null),
    createElement: jest.fn(() => registerElement(`created-${elements.size}`)),
    querySelector: (selector: string) => {
      const idMatch = String(selector).match(/^#(.+)$/);
      return idMatch ? elements.get(idMatch[1]) || null : null;
    },
  };
}

describe('JIT and class loading series', () => {
  const shared = loadShared();

  it('detects real zero values but not missing metrics', () => {
    expect(shared.hasJITData([{ JITCompiledMethods: 0 }])).toBe(true);
    expect(shared.hasJITData([{}])).toBe(false);
    expect(shared.hasClassLoadingData([{ ClassesLoaded: 0 }])).toBe(true);
  });

  it('uses an opaque export background for every chart layout', () => {
    expect(shared.getMemoryLayout().paper_bgcolor).toBe('#ffffff');
    expect(shared.getGcLayout().paper_bgcolor).toBe('#ffffff');
    expect(shared.getCounterLayout('Counter', 'Value').paper_bgcolor).toBe('#ffffff');
  });

  it('calculates rates across actual sparse observations', () => {
    const timestamps = [0, 1000, 2000, 5000];
    const samples = [
      { Timestamp: 0, Name: 'P', PID: '1', ClassesLoaded: 10 },
      { Timestamp: 1000, Name: 'P', PID: '1', ClassesLoaded: null },
      { Timestamp: 5000, Name: 'P', PID: '1', ClassesLoaded: 30 },
    ];
    const result = shared.buildCounterSeries(samples, timestamps, 'P', '1', (s: any) => s.ClassesLoaded);
    expect(Array.from(result.cumulative)).toEqual([10, 10, 10, 30]);
    expect(Array.from(result.rate)).toEqual([null, null, null, 4]);
  });

  it('aligns counter observations to the next shared compare frame', () => {
    const timestamps = [0, 2000, 4000, 6000];
    const samples = [
      { Timestamp: 1500, Name: 'P', PID: '1', JITCompiledMethods: 10 },
      { Timestamp: 3500, Name: 'P', PID: '1', JITCompiledMethods: 30 },
      { Timestamp: 5500, Name: 'P', PID: '1', JITCompiledMethods: 50 },
    ];
    const result = shared.buildCounterSeries(samples, timestamps, 'P', '1', (s: any) => s.JITCompiledMethods);
    expect(Array.from(result.cumulative)).toEqual([null, 10, 30, 50]);
    expect(Array.from(result.rate)).toEqual([null, null, 10, 10]);
  });

  it('breaks a rate segment when a counter decreases and isolates PIDs', () => {
    const samples = [
      { Timestamp: 0, Name: 'P', PID: '1', JITCompiledMethods: 10 },
      { Timestamp: 1000, Name: 'P', PID: '2', JITCompiledMethods: 100 },
      { Timestamp: 2000, Name: 'P', PID: '1', JITCompiledMethods: 5 },
      { Timestamp: 3000, Name: 'P', PID: '1', JITCompiledMethods: 9 },
    ];
    const result = shared.buildCounterSeries(samples, [0, 1000, 2000, 3000], 'P', '1', (s: any) => s.JITCompiledMethods);
    expect(Array.from(result.rate)).toEqual([null, null, null, 4]);
  });

  it('uses fresh metric times instead of cached poll times for activity rates', () => {
    const shared = loadShared();
    const timestamps = [0, 5000, 10000, 15000, 20000, 25000, 30000];
    const samples = timestamps.map((Timestamp, i) => ({
      Timestamp, Name: 'P', PID: '1', JITCompiledMethods: i < 5 ? 10 : 210, ClassesLoaded: i < 5 ? 100 : 500,
      ClassesUnloaded: i < 5 ? 20 : 120,
      MetricMeasurements: { process_start_time_ms: 1, jit_sampled_at_ms: i < 5 ? 1000 : i === 5 ? 21000 : 26000,
        classes_sampled_at_ms: i < 5 ? 2000 : i === 5 ? 22000 : 27000 },
    }));
    const data = shared.buildReplayData(samples, timestamps);
    expect(Array.from(data.series['P|1'].jitRate)).toEqual([null, null, null, null, null, 10, 0]);
    expect(Array.from(data.series['P|1'].classRate)).toEqual([null, null, null, null, null, 20, 0]);
    expect(Array.from(data.series['P|1'].classesLoaded)).toEqual([100, 100, 100, 100, 100, 500, 500]);
    const roundtrip = shared.normalizeReportData(shared.compactReportData({ samples }));
    expect(roundtrip.samples[5].MetricMeasurements).toEqual(samples[5].MetricMeasurements);
  });

  it('does not derive timed rates across missing measurements, resets or JVM lifetimes', () => {
    const shared = loadShared();
    const values = [10, 20, null, 40, 50, 5, 9, 100, 105];
    const starts = [1, 1, 1, 1, 1, 1, 1, 2, 2];
    const timestamps = values.map((_, i) => i * 1000);
    const samples = values.map((value, i) => ({ Timestamp: timestamps[i], Name: 'P', PID: '1', JITCompiledMethods: value,
      MetricMeasurements: { process_start_time_ms: starts[i], jit_sampled_at_ms: i + 1000 } }));
    const data = shared.buildReplayData(samples, timestamps);
    expect(Array.from(data.series['P|1'].jitRate)).toEqual([null, 10000, null, null, 10000, null, 4000, null, 5000]);
    const unknown = shared.buildReplayData([{ Timestamp: 0, Name: 'P', PID: '1', JITCompiledMethods: 1, MetricMeasurements: {} },
      { Timestamp: 1000, Name: 'P', PID: '1', JITCompiledMethods: 100, MetricMeasurements: {} }], [0, 1000]);
    expect(Array.from(unknown.series['P|1'].jitRate)).toEqual([null, null]);
  });

  it('ignores older metric acquisitions and normalizes numeric counter strings', () => {
    const shared = loadShared();
    const samples = [
      { Timestamp: 0, Name: 'P', PID: '1', JITCompiledMethods: '50', MetricMeasurements: { jit_sampled_at_ms: 1000 } },
      { Timestamp: 1000, Name: 'P', PID: '1', JITCompiledMethods: '60', MetricMeasurements: { jit_sampled_at_ms: 900 } },
      { Timestamp: 2000, Name: 'P', PID: '1', JITCompiledMethods: '210', MetricMeasurements: { jit_sampled_at_ms: 21000 } },
    ];
    expect(Array.from(shared.buildReplayData(samples, [0, 1000, 2000]).series['P|1'].jitRate)).toEqual([null, null, 8]);
  });

  it('builds dual-axis overlay traces for two metrics', () => {
    const timestamps = [0, 1000, 2000];
    const samples = [
      { Timestamp: 0, Name: 'P', PID: '1', RSS: 100, HeapUsed: 50, GCTime: 0 },
      { Timestamp: 1000, Name: 'P', PID: '1', RSS: 200, HeapUsed: 80, GCTime: 500 },
      { Timestamp: 2000, Name: 'P', PID: '1', RSS: 300, HeapUsed: 120, GCTime: 1500 },
    ];
    const data = shared.buildReplayData(samples, timestamps);
    const traces = shared.buildOverlayTraces(data, timestamps, 2, 'rss', 'gc', [0, 1, 2]);
    expect(traces.length).toBeGreaterThan(1);
    expect(traces.some((t: any) => t.yaxis === 'y')).toBe(true);
    expect(traces.some((t: any) => t.yaxis === 'y2')).toBe(true);
    const layout = shared.getOverlayLayout('rss', 'gc');
    expect(layout.yaxis.title).toBe('Memory (MB)');
    expect(layout.yaxis2.title).toBe('GC Time (s)');
  });

  it('uses the split elapsed axis for JIT and class loading compare charts', async () => {
    const document = createFakeDocument();
    document.registerElement('compare-section');
    const plotCalls: any[] = [];
    const shared = loadShared({
      document,
      localStorage: {
        getItem: () => 'split',
        setItem: jest.fn(),
      },
      Plotly: {
        react: jest.fn((chartId: string, traces: any[], layout: any, config: any) => {
          const chart = document.registerElement(chartId);
          chart.data = traces;
          plotCalls.push({ chartId, traces, layout, config });
          return Promise.resolve();
        }),
        restyle: jest.fn(),
      },
    });

    const baseSamples = [
      { Timestamp: 1000, ElapsedTime: 0, Name: 'GradleDaemon', PID: '1', RSS: 100, HeapUsed: 50, JITCompilationTimeMs: 100, JITCompiledMethods: 10, ClassesLoaded: 1000 },
      { Timestamp: 2000, ElapsedTime: 1, Name: 'GradleDaemon', PID: '1', RSS: 110, HeapUsed: 55, JITCompilationTimeMs: 300, JITCompiledMethods: 30, ClassesLoaded: 1200 },
      { Timestamp: 3000, ElapsedTime: 2, Name: 'GradleDaemon', PID: '1', RSS: 120, HeapUsed: 60, JITCompilationTimeMs: 600, JITCompiledMethods: 60, ClassesLoaded: 1600 },
    ];
    const compareSamples = [
      { Timestamp: 9000, ElapsedTime: 0, Name: 'GradleDaemon', PID: '2', RSS: 100, HeapUsed: 50, JITCompilationTimeMs: 200, JITCompiledMethods: 20, ClassesLoaded: 1100 },
      { Timestamp: 10000, ElapsedTime: 1, Name: 'GradleDaemon', PID: '2', RSS: 110, HeapUsed: 55, JITCompilationTimeMs: 500, JITCompiledMethods: 50, ClassesLoaded: 1400 },
      { Timestamp: 11000, ElapsedTime: 2, Name: 'GradleDaemon', PID: '2', RSS: 120, HeapUsed: 60, JITCompilationTimeMs: 900, JITCompiledMethods: 90, ClassesLoaded: 1900 },
    ];

    shared.renderCompareSection({
      baseSamples,
      compareSamplesRaw: compareSamples,
      compareSectionId: 'compare-section',
      baseLabel: 'Baseline',
      compareLabel: 'Candidate',
    });
    await Promise.resolve();
    await Promise.resolve();

    const jitTime = plotCalls.find(call => call.chartId === 'compare-jit-time');
    const classRate = plotCalls.find(call => call.chartId === 'compare-class-rate');
    expect(jitTime).toBeTruthy();
    expect(classRate).toBeTruthy();
    expect(jitTime.layout.xaxis.tickvals).toEqual([0, 2, 1, 3, 2, 4]);
    expect(jitTime.layout.shapes).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'line', x0: 2, x1: 2 }),
    ]));
    expect(jitTime.traces.find((trace: any) => trace.name.startsWith('Candidate:'))?.x).toEqual([2, 3, 4]);
    expect(classRate.layout.xaxis.tickvals).toEqual([0, 2, 1, 3, 2, 4]);

    const timeline = document.getElementById('compare-replay-timeline');
    timeline.value = '1';
    timeline.listeners.input();
    await Promise.resolve();

    const updatedClassRate = plotCalls.filter(call => call.chartId === 'compare-class-rate').at(-1);
    expect(updatedClassRate.traces.find((trace: any) => trace.name.startsWith('Candidate:'))?.x).toEqual([2, 3]);
  });

  it('preserves full Run B duration on a union timeline and aligns side-by-side Y axes', async () => {
    const document = createFakeDocument();
    document.registerElement('compare-section');
    const plotCalls: any[] = [];
    const shared = loadShared({
      document,
      localStorage: {
        getItem: () => 'side',
        setItem: jest.fn(),
      },
      Plotly: {
        react: jest.fn((chartId: string, traces: any[], layout: any, config: any) => {
          const chart = document.registerElement(chartId);
          chart.data = traces;
          plotCalls.push({ chartId, traces, layout, config });
          return Promise.resolve();
        }),
        restyle: jest.fn(),
      },
    });

    const baseSamples = [
      { Timestamp: 10_000, ElapsedTime: 10, Name: 'GradleDaemon', PID: '1', RSS: 200, HeapUsed: 100 },
      { Timestamp: 20_000, ElapsedTime: 20, Name: 'GradleDaemon', PID: '1', RSS: 250, HeapUsed: 120 },
    ];
    const compareSamples = [
      { Timestamp: 50_000, ElapsedTime: 12, Name: 'GradleDaemon', PID: '2', RSS: 400, HeapUsed: 200 },
      { Timestamp: 60_000, ElapsedTime: 22, Name: 'GradleDaemon', PID: '2', RSS: 600, HeapUsed: 300 },
      { Timestamp: 70_000, ElapsedTime: 32, Name: 'GradleDaemon', PID: '2', RSS: 800, HeapUsed: 350 },
      { Timestamp: 80_000, ElapsedTime: 42, Name: 'GradleDaemon', PID: '2', RSS: 1000, HeapUsed: 400 },
    ];

    shared.renderCompareSection({
      baseSamples,
      compareSamplesRaw: compareSamples,
      compareSectionId: 'compare-section',
      baseLabel: 'Short',
      compareLabel: 'Long',
    });
    await Promise.resolve();
    await Promise.resolve();

    const leftRss = plotCalls.find(call => call.chartId === 'compare-current-rss');
    const rightRss = plotCalls.find(call => call.chartId === 'compare-other-rss');
    expect(leftRss).toBeTruthy();
    expect(rightRss).toBeTruthy();
    // Run B has 4 timestamps spanning 30s elapsed (0, 10, 20, 30) — not clipped to Run A's 10s!
    const rightTotal = rightRss.traces.find((t: any) => t.name === 'Compare Total RSS Memory');
    expect(rightTotal.x).toEqual([0, 10, 20, 30]);
    // Both side-by-side charts share the same fixed Y range driven by the combined peak (1000 * 1.1 = 1100).
    expect(leftRss.layout.yaxis.range).toEqual(rightRss.layout.yaxis.range);
    expect(leftRss.layout.yaxis.range[1]).toBe(1100);
    // Delta KPI strip is rendered in the comparison section.
    expect(document.getElementById('compare-section').innerHTML).toContain('compare-kpi-strip');
  });

  it('derives GC collector type from VM flags', () => {
    expect(shared.getGcType(['-XX:+UseG1GC', '-XX:MaxGCPauseMillis=200'])).toBe('G1');
    expect(shared.getGcType(['-XX:+UseZGC'])).toBe('ZGC');
    expect(shared.getGcType(['-Xmx2g'])).toBe('Default');
  });

  it('isolates GC-related flag differences', () => {
    const baseFlags = shared.getGcFlags(['-XX:+UseG1GC', '-XX:MaxGCPauseMillis=200', '-Xmx2g']);
    const compareFlags = shared.getGcFlags(['-XX:+UseZGC', '-XX:MaxGCPauseMillis=200', '-XX:+DisableExplicitGC']);
    expect(baseFlags).toEqual(['-XX:+UseG1GC', '-XX:MaxGCPauseMillis=200']);
    expect(compareFlags).toEqual(['-XX:+DisableExplicitGC', '-XX:+UseZGC', '-XX:MaxGCPauseMillis=200']);
    expect(shared.diffFlags(baseFlags, compareFlags)).toEqual({
      added: ['-XX:+DisableExplicitGC', '-XX:+UseZGC'],
      removed: ['-XX:+UseG1GC'],
      shared: ['-XX:MaxGCPauseMillis=200'],
    });
  });
});

describe('memory chart filters', () => {
  it('binds filter controls once while reapplying their state on later renders', () => {
    const document = createFakeDocument();
    const total = document.registerElement('filter-total');
    const rss = document.registerElement('filter-rss');
    const heap = document.registerElement('filter-heap');
    const chart = document.registerElement('memory-chart');
    chart.data = [
      { name: 'Total RSS Memory' },
      { name: 'GradleDaemon (RSS)' },
      { name: 'GradleDaemon (Heap)' },
    ];
    const restyle = jest.fn();
    const shared = loadShared({ document, Plotly: { restyle } });

    const setup = () => shared.setupMemoryChartFilters(
      'memory-chart',
      'filter-total',
      'filter-rss',
      'filter-heap',
      (name: string) => name === 'Total RSS Memory',
    );

    setup();
    setup();

    expect(total.addEventListener).toHaveBeenCalledTimes(1);
    expect(rss.addEventListener).toHaveBeenCalledTimes(1);
    expect(heap.addEventListener).toHaveBeenCalledTimes(1);
    expect(restyle).toHaveBeenCalledTimes(2);

    rss.checked = false;
    rss.listeners.change();

    expect(shared.visibilityStore['memory-chart']['GradleDaemon (RSS)']).toBe('legendonly');
    expect(restyle).toHaveBeenLastCalledWith(chart, 'visible', [true, 'legendonly', true]);
  });

  it('syncs filter controls after legend visibility changes', () => {
    const document = createFakeDocument();
    const total = document.registerElement('filter-total');
    const rss = document.registerElement('filter-rss');
    const heap = document.registerElement('filter-heap');
    const chart = document.registerElement('memory-chart');
    chart.data = [
      { name: 'Total RSS Memory' },
      { name: 'GradleDaemon (RSS)' },
      { name: 'GradleDaemon (Heap)' },
    ];
    const shared = loadShared({ document, Plotly: { restyle: jest.fn() } });

    shared.setupMemoryChartFilters(
      'memory-chart',
      'filter-total',
      'filter-rss',
      'filter-heap',
      (name: string) => name === 'Total RSS Memory',
    );
    const legendHandler = chart.on.mock.calls[0][1];
    legendHandler([{ visible: 'legendonly' }, [0]]);
    legendHandler([{ visible: 'legendonly' }, [1]]);

    expect(total.checked).toBe(false);
    expect(rss.checked).toBe(false);
    expect(heap.checked).toBe(true);
  });

  it.each([
    '../frontend/public/replay.js',
    '../frontend/public/run-dashboard.js',
  ])('uses the shared filter helper in %s', relativePath => {
    const source = fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
    expect(source).toContain('setupMemoryChartFilters');
    expect(source).not.toMatch(/function setup(?:SingleReplay|MainChart)Filters/);
    expect(source).not.toMatch(/function update(?:SingleReplay|MainChart)FilterCheckboxes/);
  });
});

describe('compact JSON samples', () => {
  const shared = loadShared();

  it('expands field-indexed rows while preserving legacy object samples', () => {
    const compact = shared.parseJsonText(JSON.stringify({
      sample_fields: ['Timestamp', 'PID', 'RSS'],
      samples: [[1000, '42', 128], [2000, '42', null]],
      process_info: { '42': { name: 'GradleDaemon' } },
    }));

    expect(compact.samples).toEqual([
      { Timestamp: 1000, PID: '42', RSS: 128 },
      { Timestamp: 2000, PID: '42', RSS: null },
    ]);

    const legacy = shared.parseJsonText(JSON.stringify({ samples: [{ Timestamp: 1000, PID: '42' }] }));
    expect(legacy.samples).toEqual([{ Timestamp: 1000, PID: '42' }]);
  });

  it('compacts object samples using one shared field list', () => {
    expect(shared.compactSamples([
      { Timestamp: 1000, PID: '42', RSS: 128 },
      { Timestamp: 2000, PID: '42', RSS: 256 },
    ])).toEqual({
      sample_fields: ['Timestamp', 'PID', 'RSS'],
      samples: [[1000, '42', 128], [2000, '42', 256]],
    });
  });
});
