import { MermaidProcessData } from '../src/lib/mermaid';
import {
  escapeSvgText,
  generateGcSvg,
  generateMetricSvg,
  generateSvg,
  lightenHexColor,
} from '../src/lib/report_svg';

function processFixture(overrides: Partial<MermaidProcessData> = {}): MermaidProcessData {
  return {
    timestamps: ['00:00:00', '00:00:05'],
    rss: [100, 120],
    heapUsed: [50, 60],
    heapCap: [512, 512],
    jitCompiledMethods: [10, 20],
    jitFailedCompilations: [0, 1],
    classesLoaded: [100, 150],
    classesUnloaded: [0, 2],
    ...overrides,
  };
}

describe('lightenHexColor', () => {
  it('lightens a six-digit hex color by the requested amount', () => {
    expect(lightenHexColor('#000000', 16)).toBe('#101010');
    expect(lightenHexColor('#E4572E', 80)).toBe('#ffa77e');
  });

  it('returns the original value for non-hex input', () => {
    expect(lightenHexColor('red', 10)).toBe('red');
  });
});

describe('escapeSvgText', () => {
  it('escapes XML-sensitive characters', () => {
    expect(escapeSvgText(`A & B <C> "D" 'E'`)).toBe(
      'A &amp; B &lt;C&gt; &quot;D&quot; &apos;E&apos;'
    );
  });
});

describe('generateSvg', () => {
  it('renders memory chart structure for a single process', () => {
    const processes = new Map([['GradleDaemon', processFixture()]]);
    const svg = generateSvg(processes, ['00:00:00', '00:00:05']);

    expect(svg).toContain('Build Process Memory Usage Over Time');
    expect(svg).toContain('GradleDaemon (RSS)');
    expect(svg).toContain('Aggregated RSS');
    expect(svg).toContain('<path d=');
  });
});

describe('generateGcSvg', () => {
  it('shows a fallback message when GC data is absent', () => {
    const processes = new Map([['GradleDaemon', processFixture()]]);
    const svg = generateGcSvg(processes, ['00:00:00', '00:00:05']);

    expect(svg).toContain('No GC data available');
  });

  it('renders GC polylines when GC samples exist', () => {
    const processes = new Map([[
      'GradleDaemon',
      processFixture({ gcTime: [0.1, 0.2] }),
    ]]);
    const svg = generateGcSvg(processes, ['00:00:00', '00:00:05']);

    expect(svg).toContain('Build Process GC Time Over Time');
    expect(svg).toContain('<polyline points=');
    expect(svg).toContain('GradleDaemon (GC Time)');
  });
});

describe('generateMetricSvg', () => {
  it('renders a metric series title and legend', () => {
    const processes = new Map([['GradleDaemon', processFixture()]]);
    const svg = generateMetricSvg(processes, ['00:00:00', '00:00:05'], {
      title: 'Build Process JIT Compiled Methods Over Time',
      yAxisLabel: 'Compiled Methods',
      noDataMessage: 'No JIT compilation data available',
      metric: process => process.jitCompiledMethods,
    });

    expect(svg).toContain('Build Process JIT Compiled Methods Over Time');
    expect(svg).toContain('Compiled Methods');
    expect(svg).toContain('GradleDaemon');
    expect(svg).toContain('<path d=');
  });

  it('escapes title text and shows the no-data message when values are empty', () => {
    const processes = new Map([[
      'GradleDaemon',
      processFixture({ jitCompiledMethods: [null, null] }),
    ]]);
    const svg = generateMetricSvg(processes, ['00:00:00', '00:00:05'], {
      title: 'Title <x>',
      yAxisLabel: 'Y',
      noDataMessage: 'None & void',
      metric: process => process.jitCompiledMethods,
    });

    expect(svg).toContain('Title &lt;x&gt;');
    expect(svg).toContain('None &amp; void');
  });
});
