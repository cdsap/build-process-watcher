import fs from 'fs';
import path from 'path';
import vm from 'vm';

function loadChartPanels(): any {
  const sandbox: any = {};
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../frontend/public/replay-controls.js'), 'utf8'),
    sandbox,
  );
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../frontend/public/chart-panels.js'), 'utf8'),
    sandbox,
  );
  return sandbox.BpwChartPanels;
}

const chartPanels = loadChartPanels();
const runPanelHtml = chartPanels.render({
  chartIdPrefix: '',
  showGC: true,
  showJIT: true,
  showClasses: true,
  includeUnifiedReplay: true,
  includeRunControls: true,
  showMemoryReplay: true,
  showMetricReplay: true,
});
const replayPanelHtml = chartPanels.render({
  chartIdPrefix: 'single-',
  showGC: true,
  showJIT: true,
  showClasses: true,
  includeUnifiedReplay: true,
});

describe('completed-run replay controls', () => {
  test.each([
    ['rss', 'Memory'],
    ['gc', 'GC'],
    ['jit', 'JIT'],
    ['classes', 'Class loading'],
  ])('gives the %s timeline and speed controls unique accessible names', (panel, name) => {
    expect(runPanelHtml).toContain(
      `<input type="range" id="${panel}-replay-timeline" aria-label="${name} replay timeline"`
    );
    expect(runPanelHtml).toContain(
      `<select id="${panel}-replay-speed" aria-label="${name} replay speed">`
    );
  });

  test.each(['rss', 'gc', 'jit', 'classes'])(
    'gives %s the same Play / Pause / Reset chrome and speed ladder',
    panel => {
      expect(runPanelHtml).toContain(`id="btn-${panel}-replay-play"`);
      expect(runPanelHtml).toContain(`id="btn-${panel}-replay-pause"`);
      expect(runPanelHtml).toContain(`id="btn-${panel}-replay-reset"`);

      const speedBlock = runPanelHtml.match(
        new RegExp(`<select id="${panel}-replay-speed"[^>]*>([\\s\\S]*?)<\\/select>`)
      )?.[1];
      expect(speedBlock).toBeDefined();
      expect(speedBlock?.replace(/\s+/g, '')).toContain(
        [
          '<option value="5">5x</option>',
          '<option value="10">10x</option>',
          '<option value="15" selected>15x</option>',
          '<option value="20">20x</option>',
          '<option value="25">25x</option>',
          '<option value="30">30x</option>',
          '<option value="35">35x</option>',
          '<option value="40">40x</option>',
          '<option value="45">45x</option>',
          '<option value="50">50x</option>',
        ].join('').replace(/\s+/g, '')
      );
    }
  );

  it('places downloads then replay above every metric chart container', () => {
    const groups = [
      ['rss', 'btn-download-png', 'btn-download-svg'],
      ['gc', 'btn-download-gc-png', 'btn-download-gc-svg'],
      ['jit', 'btn-download-jit-png', 'btn-download-jit-svg'],
      ['classes', 'btn-download-classes-png', 'btn-download-classes-svg'],
    ];

    groups.forEach(([panel, pngButton, svgButton]) => {
      const pngIndex = runPanelHtml.indexOf(`id="${pngButton}"`);
      const svgIndex = runPanelHtml.indexOf(`id="${svgButton}"`);
      const replayIndex = runPanelHtml.indexOf(`id="${panel}-replay-controls"`);
      const chartIndex = runPanelHtml.indexOf(
        panel === 'rss'
          ? 'id="chart"'
          : panel === 'gc'
            ? 'id="gc-chart"'
            : panel === 'jit'
              ? 'id="jit-time-chart"'
              : 'id="classes-loaded-chart"'
      );

      expect(pngIndex).toBeGreaterThan(-1);
      expect(svgIndex).toBeGreaterThan(pngIndex);
      expect(replayIndex).toBeGreaterThan(svgIndex);
      expect(chartIndex).toBeGreaterThan(replayIndex);
    });
  });
});

describe('remote run dashboard panels', () => {
  test.each([
    '../frontend/public/runs/[runId].html',
    '../frontend/public/runs/demo.html',
  ])('%s omits the Heap/RSS ratio panel', _relativePath => {
    const source = fs.readFileSync(
      path.join(__dirname, '../frontend/public/run-dashboard.js'),
      'utf8',
    );

    expect(source).not.toContain('data-bpw-panel="ratio"');
    expect(source).not.toContain('id="rss-heap-chart"');
  });
});

describe('remote run dashboard metric tools', () => {
  it('gives all four metric groups downloads followed by replay', () => {
    const source = runPanelHtml;
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

    const runSource = fs.readFileSync(path.join(__dirname, '../frontend/public/run-dashboard.js'), 'utf8');
    expect(runSource).toContain("downloadRuntimeChart('jit-time-chart', 'jit', 'png')");
    expect(runSource).toContain("downloadRuntimeChart('jit-time-chart', 'jit', 'svg')");
    expect(runSource).toContain("downloadRuntimeChart('classes-loaded-chart', 'classes', 'png')");
    expect(runSource).toContain("downloadRuntimeChart('classes-loaded-chart', 'classes', 'svg')");
  });
});

describe('runtime metric panel consistency', () => {
  test.each([
    ['run panels', runPanelHtml, ['jit-time-chart', 'jit-rate-chart', 'classes-loaded-chart', 'class-rate-chart']],
    ['replay panels', replayPanelHtml, ['single-jit-time', 'single-jit-rate', 'single-classes-loaded', 'single-class-rate']],
  ])('%s gives every JIT and class loading chart its own chart container', (_label, source, chartIds) => {
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
    ['Replay unified view', '../frontend/public/chart-panels.js', 'bpw-unified'],
  ])('%s exposes a named slider and combobox', (_page, relativePath, controlPrefix) => {
    const source = relativePath.endsWith('chart-panels.js')
      ? replayPanelHtml
      : fs.readFileSync(path.join(__dirname, relativePath), 'utf8');

    expect(source).toContain(
      `type="range" id="${controlPrefix}-timeline" aria-label="Replay position"`
    );
    expect(source).toContain(
      `id="${controlPrefix}-speed" aria-label="Playback speed"`
    );
  });

  it('Compare builds shared replay controls with labeled slider and speed', () => {
    const shared = fs.readFileSync(path.join(__dirname, '../frontend/public/compare-shared.js'), 'utf8');
    const controls = fs.readFileSync(path.join(__dirname, '../frontend/public/replay-controls.js'), 'utf8');

    expect(shared).toContain("idPrefix: 'compare-replay'");
    expect(shared).toContain('BpwReplayControls.renderReplayControls');
    expect(controls).toContain('type="range" id="${idPrefix}-timeline" aria-label="${timelineAria}"');
    expect(controls).toContain('id="${idPrefix}-speed" aria-label="${speedAria}"');
    expect(controls).toContain("opts.timelineAriaLabel || 'Replay position'");
    expect(controls).toContain("opts.speedAriaLabel || 'Playback speed'");
  });

  it('uses the classic replay speed options for the unified replay', () => {
    const classicOptions = `
                            <option value="5">5x</option>
                            <option value="10">10x</option>
                            <option value="15" selected>15x</option>
                            <option value="20">20x</option>
                            <option value="25">25x</option>
                            <option value="30">30x</option>
                            <option value="35">35x</option>
                            <option value="40">40x</option>
                            <option value="45">45x</option>
                            <option value="50">50x</option>
                        `;
    const unifiedOptions = replayPanelHtml.match(
      /<select id="bpw-unified-speed"[^>]*>([\s\S]*?)<\/select>/
    )?.[1];
    const replaySource = fs.readFileSync(path.join(__dirname, '../frontend/public/replay.js'), 'utf8');
    const classicFromReplay = replaySource.match(
      /<select id="single-replay-speed"[^>]*>([\s\S]*?)<\/select>/
    )?.[1];

    expect(unifiedOptions).toBeDefined();
    expect(unifiedOptions?.replace(/\s+/g, '')).toBe(classicOptions.replace(/\s+/g, ''));
    expect(classicFromReplay?.replace(/\s+/g, '')).toBe(classicOptions.replace(/\s+/g, ''));
  });

  test.each([
    '../frontend/public/replay.html',
    '../frontend/public/runs/[runId].html',
    '../frontend/public/runs/demo.html',
  ])('%s loads the playback clock before the experiment layout', relativePath => {
    const source = fs.readFileSync(path.join(__dirname, relativePath), 'utf8');

    expect(source.indexOf('/playback-clock.js')).toBeGreaterThan(-1);
    expect(source.indexOf('/experiment-layout.js')).toBeGreaterThan(
      source.indexOf('/playback-clock.js')
    );
  });
});
