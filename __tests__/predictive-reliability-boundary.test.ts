import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.join(__dirname, '..');

function readRepoFile(file: string): string {
  return fs.readFileSync(path.join(repoRoot, file), 'utf8');
}

function repoFileExists(file: string): boolean {
  return fs.existsSync(path.join(repoRoot, file));
}

function trackedFiles(): string[] {
  return childProcess
    .execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .map(file => file.trim())
    .filter(Boolean);
}

describe('predictive reliability public boundary', () => {
  it('keeps private predictive artifacts ignored', () => {
    const gitignore = readRepoFile('.gitignore');

    expect(gitignore).toContain('backend/schema/predictive_reliability/');
    expect(gitignore).toContain('PREDICTIVE_RELIABILITY_IMPLEMENTATION.md');
    expect(gitignore).toContain('docs/plans/predictive-reliability-n-second-checkpoints.md');
    expect(gitignore).toContain('scripts/generate-predictive-reliability-window.js');
    expect(gitignore).toContain('requirements.md');
  });

  it('does not track private model implementation artifacts', () => {
    const tracked = trackedFiles();
    const privatePaths = [
      'backend/schema/predictive_reliability/',
      'PREDICTIVE_RELIABILITY_IMPLEMENTATION.md',
      'docs/plans/predictive-reliability-n-second-checkpoints.md',
      'scripts/generate-predictive-reliability-window.js',
      'requirements.md',
    ];

    for (const file of tracked) {
      expect(privatePaths.some(privatePath => file === privatePath || file.startsWith(privatePath))).toBe(false);
    }
  });

  it('keeps tracked public files free of concrete predictive model internals', () => {
    const disallowedPatterns = [
      /CREATE\s+(OR\s+REPLACE\s+)?MODEL/i,
      /ML\.(PREDICT|EVALUATE|DETECT_ANOMALIES)/i,
      /\bpeak_rss_\d+s\b/,
      /\bduration_\d+s\b/,
      /\bbehavior_anomaly_\d+s\b/,
      /\brun_early_features_\d+s\b/,
    ];

    const violations = trackedFiles()
      .filter(file => repoFileExists(file))
      .filter(file => /\.(md|ts|js|go|ya?ml|json|sql|html|css)$/.test(file))
      .flatMap(file => {
        const contents = readRepoFile(file);
        return disallowedPatterns
          .filter(pattern => pattern.test(contents))
          .map(pattern => `${file}: ${pattern}`);
      });

    expect(violations).toEqual([]);
  });
});
