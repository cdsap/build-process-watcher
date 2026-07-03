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
    ['ratio', 'Heap/RSS ratio'],
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
