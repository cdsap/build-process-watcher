import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

function loadShared(overrides: Record<string, any> = {}): any {
  const window: any = { innerWidth: 1200 };
  const context = vm.createContext({
    window,
    document: {},
    localStorage: { getItem: () => null },
    ...overrides,
  });
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
    expect(jitTime.traces.find((trace: any) => trace.name.startsWith('Candidate:'))?.x).toEqual([2]);
    expect(classRate.layout.xaxis.tickvals).toEqual([0, 2, 1, 3, 2, 4]);

    document.getElementById('compare-replay-timeline').listeners.input({ target: { value: '1' } });
    await Promise.resolve();

    const updatedClassRate = plotCalls.filter(call => call.chartId === 'compare-class-rate').at(-1);
    expect(updatedClassRate.traces.find((trace: any) => trace.name.startsWith('Candidate:'))?.x).toEqual([2, 3]);
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
