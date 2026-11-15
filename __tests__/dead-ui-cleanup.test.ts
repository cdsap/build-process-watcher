import * as fs from 'fs';
import * as path from 'path';

const publicDir = path.join(__dirname, '../frontend/public');

describe('dead compare/ratio UI cleanup', () => {
  const sources = [
    path.join(publicDir, 'runs/[runId].html'),
    path.join(publicDir, 'runs/demo.html'),
    path.join(publicDir, 'run-dashboard.js'),
  ];

  it.each(sources)('removes unreachable legacy compare and orphaned ratio helpers: %s', (page) => {
    const source = fs.readFileSync(page, 'utf8');
    expect(source).not.toContain('function renderCompareSectionLegacy');
    expect(source).not.toContain('function renderRssHeapRatioChart');
    expect(source).not.toContain('function shouldShowRssHeapRatioChart');
    expect(source).not.toContain('function downloadRssHeapRatioChart');
    expect(source).not.toContain('function buildRatioTraces');
    expect(source).not.toContain('ratioFilenameBase');
  });

  it('keeps the shared compare mount path', () => {
    const source = fs.readFileSync(path.join(publicDir, 'run-dashboard.js'), 'utf8');
    expect(source).toContain('CompareShared.renderCompareSection');
  });

  it('drops ratio from experiment panel presets and compare options', () => {
    const layout = fs.readFileSync(path.join(publicDir, 'experiment-layout.js'), 'utf8');
    const compare = fs.readFileSync(path.join(publicDir, 'compare.js'), 'utf8');
    const shared = fs.readFileSync(path.join(publicDir, 'compare-shared.js'), 'utf8');

    expect(layout).not.toMatch(/ratio:\s*{\s*label:\s*'Heap\/RSS'/);
    expect(layout).not.toContain("'ratio'");
    expect(compare).not.toContain('ratioFilenameBase');
    expect(shared).not.toContain('ratioFilenameBase');
    // Studio overlays may still expose ratio as a metric via shared helpers.
    expect(shared).toContain('function hasRatioData');
    expect(shared).toContain('function getRatioLayout');
  });
});
