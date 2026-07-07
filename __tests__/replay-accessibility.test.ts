import fs from 'fs';
import path from 'path';

describe('completed-run replay controls', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../frontend/public/runs/[runId].html'),
    'utf8'
  );

  test.each([
    ['rss', 'Memory'],
    ['gc', 'GC'],
    ['jit', 'JIT'],
    ['classes', 'Class loading'],
  ])('gives the %s timeline and speed controls unique accessible names', (panel, name) => {
    expect(source).toContain(
      `<input type="range" id="${panel}-replay-timeline" aria-label="${name} replay timeline"`
    );
    expect(source).toContain(
      `<select id="${panel}-replay-speed" aria-label="${name} replay speed">`
    );
  });
});

describe('remote run dashboard panels', () => {
  test.each([
    '../frontend/public/runs/[runId].html',
    '../frontend/public/runs/demo.html',
  ])('%s omits the Heap/RSS ratio panel', relativePath => {
    const source = fs.readFileSync(path.join(__dirname, relativePath), 'utf8');

    expect(source).not.toContain('data-bpw-panel="ratio"');
    expect(source).not.toContain('id="rss-heap-chart"');
  });
});

describe('remote run dashboard metric tools', () => {
  test.each([
    '../frontend/public/runs/[runId].html',
    '../frontend/public/runs/demo.html',
  ])('%s gives all four metric groups downloads followed by replay', relativePath => {
    const source = fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
    const groups = [
      ['rss', 'btn-download-png', 'btn-download-svg'],
      ['gc', 'btn-download-gc-png', 'btn-download-gc-svg'],
      ['jit', 'btn-download-jit-png', 'btn-download-jit-svg'],
      ['classes', 'btn-download-classes-png', 'btn-download-classes-svg'],
    ];

    groups.forEach(([panel, pngButton, svgButton]) => {
      const pngIndex = source.indexOf(`id="${pngButton}"`);
      const svgIndex = source.indexOf(`id="${svgButton}"`);
      const replayIndex = source.indexOf(`id="${panel}-replay-controls"`);

      expect(pngIndex).toBeGreaterThan(-1);
      expect(svgIndex).toBeGreaterThan(pngIndex);
      expect(replayIndex).toBeGreaterThan(svgIndex);
    });

    expect(source).toContain("downloadRuntimeChart('jit-time-chart', 'jit', 'png')");
    expect(source).toContain("downloadRuntimeChart('jit-time-chart', 'jit', 'svg')");
    expect(source).toContain("downloadRuntimeChart('classes-loaded-chart', 'classes', 'png')");
    expect(source).toContain("downloadRuntimeChart('classes-loaded-chart', 'classes', 'svg')");
  });
});

describe('runtime metric panel consistency', () => {
  test.each([
    '../frontend/public/runs/[runId].html',
    '../frontend/public/runs/demo.html',
    '../frontend/public/replay.js',
  ])('%s gives every JIT and class loading chart its own chart container', relativePath => {
    const source = fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
    const chartIds = relativePath.endsWith('replay.js')
      ? ['single-jit-time', 'single-jit-rate', 'single-classes-loaded', 'single-class-rate']
      : ['jit-time-chart', 'jit-rate-chart', 'classes-loaded-chart', 'class-rate-chart'];

    chartIds.forEach(chartId => {
      expect(source).toMatch(new RegExp(
        `<div class="chart-container">\\s*<div class="chart-wrapper">\\s*<div id="${chartId}"`,
      ));
    });
  });

  it('renders comparison counter diagrams in separate chart containers', () => {
    const source = fs.readFileSync(path.join(__dirname, '../frontend/public/compare-shared.js'), 'utf8');

    expect(source).toContain('metrics.map(([id, metricTitle]) => `<div class="chart-container">');
    expect(source).not.toContain("<div class=\"chart-container\"><h4>${title}</h4>${metrics.map");
  });
});

describe('production replay controls', () => {
  test.each([
    ['Replay', '../frontend/public/replay.js', 'single-replay'],
    ['Replay unified view', '../frontend/public/replay.js', 'bpw-unified'],
    ['Compare', '../frontend/public/compare-shared.js', 'compare-replay'],
  ])('%s exposes a named slider and combobox', (_page, relativePath, controlPrefix) => {
    const source = fs.readFileSync(path.join(__dirname, relativePath), 'utf8');

    expect(source).toContain(
      `type="range" id="${controlPrefix}-timeline" aria-label="Replay position"`
    );
    expect(source).toContain(
      `id="${controlPrefix}-speed" aria-label="Playback speed"`
    );
  });
});
