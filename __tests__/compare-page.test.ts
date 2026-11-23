import * as fs from 'fs';
import * as path from 'path';

describe('compare replay controls', () => {
  const sharedSource = fs.readFileSync(
    path.join(__dirname, '../frontend/public/compare-shared.js'),
    'utf8',
  );
  const chromeSource = fs.readFileSync(
    path.join(__dirname, '../frontend/public/bpw-ui.css'),
    'utf8',
  );

  it('keeps the playback controls visible while scrolling through comparisons', () => {
    expect(sharedSource).toContain('class="replay-controls compare-replay-controls"');
    expect(chromeSource).toMatch(
      /\.compare-replay-controls\s*{[^}]*position:\s*sticky;[^}]*top:\s*0\.75rem;[^}]*z-index:\s*10;/s,
    );
  });

  it('provides swap, clear, and dropzone controls on compare.html without experiment chrome', () => {
    const compareHtml = fs.readFileSync(
      path.join(__dirname, '../frontend/public/compare.html'),
      'utf8',
    );
    const compareJs = fs.readFileSync(
      path.join(__dirname, '../frontend/public/compare.js'),
      'utf8',
    );
    expect(compareHtml).toContain('id="btn-compare-swap"');
    expect(compareHtml).toContain('id="btn-compare-clear"');
    expect(compareHtml).toContain('id="compare-dropzone"');
    expect(compareHtml).not.toContain('experiment-layout.js');
    expect(compareJs).toContain("swapBtn.addEventListener('click'");
    expect(compareJs).toContain("dropzone.addEventListener('drop'");
  });

  it('destroys previous compare clock on re-render and disables sticky replay bar on narrow viewports', () => {
    expect(sharedSource).toContain('global.compareReplayStops.default = () => binding.destroy();');
    expect(sharedSource).toContain("initialFrame: 'end'");
    expect(chromeSource).toMatch(/@media \(max-width: 920px\)[\s\S]*\.compare-replay-controls\s*{\s*position:\s*static;\s*}/);
  });
});
