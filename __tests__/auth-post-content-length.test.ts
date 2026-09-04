import * as fs from 'fs';
import * as path from 'path';

describe('empty auth POST Content-Length contract', () => {
  it('sends an empty body on monitor auth curl so Content-Length is set', () => {
    const script = fs.readFileSync(
      path.join(__dirname, '../monitor_with_backend.sh'),
      'utf8'
    );
    const match = script.match(/get_auth_token\(\) \{[\s\S]*?\n\}/);
    expect(match).not.toBeNull();

    const authFn = match![0];
    expect(authFn).toMatch(/-X POST/);
    // Empty -d forces Content-Length: 0; omitting it causes HTTP 411 on Windows/GFE.
    expect(authFn).toMatch(/-d ''/);
  });

  it('sends an empty body on cleanup auth and finish fetch calls', () => {
    const cleanup = fs.readFileSync(path.join(__dirname, '../src/cleanup.ts'), 'utf8');

    const authFetch = cleanup.match(
      /fetch\(`\$\{backendUrl\}\/auth\/run\/\$\{runId\}`,\s*\{[\s\S]*?\}\)/
    );
    expect(authFetch).not.toBeNull();
    expect(authFetch![0]).toMatch(/method:\s*'POST'/);
    expect(authFetch![0]).toMatch(/body:\s*''/);

    const finishFetch = cleanup.match(
      /fetch\(`\$\{backendUrl\}\/finish\/\$\{runId\}`,\s*\{[\s\S]*?\}\)/
    );
    expect(finishFetch).not.toBeNull();
    expect(finishFetch![0]).toMatch(/method:\s*'POST'/);
    expect(finishFetch![0]).toMatch(/body:\s*''/);
  });
});
