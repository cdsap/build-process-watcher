import * as fs from 'fs';
import * as path from 'path';

describe('run dashboard unavailable state', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../frontend/public/runs/[runId].html'),
    'utf8',
  );

  it('classifies unavailable responses without rendering low-level fetch errors', () => {
    expect(source).toContain("response.status === 404 || response.status === 410");
    expect(source).toContain("showUnavailableRun('server')");
    expect(source).toContain("showUnavailableRun(response ? 'server' : 'connectivity')");
    expect(source).not.toContain('Failed to load run data: ${message}');
  });

  it('offers retry and home actions', () => {
    expect(source).toContain('id="retry-run-load"');
    expect(source).toContain("addEventListener('click', () => loadRunData(runId))");
    expect(source).toContain('Back to Home');
  });
});
