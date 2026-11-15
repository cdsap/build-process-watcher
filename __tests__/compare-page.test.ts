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
});
