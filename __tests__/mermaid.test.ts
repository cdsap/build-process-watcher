import { generateCombinedMermaidChart, MermaidProcessData } from '../src/lib/mermaid';

function processData(overrides: Partial<MermaidProcessData> = {}): MermaidProcessData {
  return {
    timestamps: ['00:00:00', '00:00:05'],
    rss: [256, 384],
    heapUsed: [128, 192],
    heapCap: [512, 512],
    gcTime: [0.1, 0.25],
    gcAvailable: [true, true],
    jitCompiledMethods: [40, 75],
    jitFailedCompilations: [1, 2],
    classesLoaded: [900, 1200],
    classesUnloaded: [10, 20],
    ...overrides,
  };
}

describe('generateCombinedMermaidChart', () => {
  it('uses the original dark palette without an outer graph title', () => {
    const chart = generateCombinedMermaidChart(
      new Map([['123-GradleDaemon', processData()]]),
      ['00:00:00', '00:00:05'],
    );

    expect(chart).toContain("'theme': 'dark'");
    expect(chart).toContain('subgraph Time[" "]');
    expect(chart).not.toContain('JVM Telemetry Over Time');
    expect(chart).toContain('classDef process fill:#4ECDC4,stroke:#333,stroke-width:2px');
    expect(chart).toContain('classDef aggregated fill:#FF6B6B,stroke:#333,stroke-width:2px');
  });

  it('shows all available JVM metrics in each process node', () => {
    const processes = new Map([['123-GradleDaemon', processData()]]);

    const chart = generateCombinedMermaidChart(processes, ['00:00:00', '00:00:05']);

    expect(chart).toContain('123-GradleDaemon<br/>RSS 384MB<br/>Heap 192/512MB');
    expect(chart).toContain('GC 0.250s');
    expect(chart).toContain('JIT 75 compiled / 2 failed');
    expect(chart).toContain('Classes 1200 loaded / 20 unloaded');
    expect(chart).toContain('Aggregated<br/>RSS 384MB<br/>GC 0.250s');
  });

  it('omits unavailable optional metrics instead of displaying zero', () => {
    const processes = new Map([['123-GradleDaemon', processData({
      gcTime: [0, 0],
      gcAvailable: [false, false],
      jitCompiledMethods: [null, null],
      jitFailedCompilations: [null, null],
      classesLoaded: [null, null],
      classesUnloaded: [null, null],
    })]]);

    const chart = generateCombinedMermaidChart(processes, ['00:00:00', '00:00:05']);

    expect(chart).toContain('RSS 384MB<br/>Heap 192/512MB');
    expect(chart).not.toContain('<br/>GC ');
    expect(chart).not.toContain('<br/>JIT ');
    expect(chart).not.toContain('<br/>Classes ');
  });

  it('limits long runs to six representative checkpoints including first and last', () => {
    const timestamps = Array.from({ length: 20 }, (_, index) => `00:00:${String(index).padStart(2, '0')}`);
    const values = timestamps.map((_, index) => index);
    const processes = new Map([['1-Proc', processData({
      timestamps,
      rss: values,
      heapUsed: values,
      heapCap: values.map(() => 100),
      gcTime: values,
      gcAvailable: values.map(() => true),
      jitCompiledMethods: values,
      jitFailedCompilations: values,
      classesLoaded: values,
      classesUnloaded: values,
    })]]);

    const chart = generateCombinedMermaidChart(processes, timestamps);

    expect((chart.match(/subgraph T\d+/g) || [])).toHaveLength(6);
    expect(chart).toContain('subgraph T0["00:00:00"]');
    expect(chart).toContain('subgraph T5["00:00:19"]');
  });
});
