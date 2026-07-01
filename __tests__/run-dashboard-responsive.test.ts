import * as fs from 'fs';
import * as path from 'path';

describe('run dashboard responsive layout', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../frontend/public/runs/[runId].html'),
    'utf8',
  );

  it('allows chart wrappers to shrink to the mobile viewport', () => {
    const mobileRules = source.match(/@media \(max-width: 480px\)\s*{([\s\S]*?)\n\s*}\n\s*}/);

    expect(mobileRules).not.toBeNull();
    expect(mobileRules?.[1]).toMatch(/\.chart-wrapper\s*{[^}]*min-width:\s*0\s*;/);
    expect(mobileRules?.[1]).not.toMatch(/\.chart-wrapper\s*{[^}]*min-width:\s*[1-9]\d*px\s*;/);
  });
});
