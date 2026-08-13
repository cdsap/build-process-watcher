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

function joined(...parts: string[]): string {
  return parts.join('');
}

function underscored(...parts: string[]): string {
  return parts.join('_');
}

function predictiveEnv(suffix: string): string {
  return ['PREDICTIVE', 'PROVIDER', suffix].join('_');
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
      new RegExp(`${joined('CREATE')}\\s+(OR\\s+REPLACE\\s+)?${joined('MODEL')}`, 'i'),
      new RegExp(`${joined('ML')}\\.(${joined('PREDICT')}|${joined('EVALUATE')}|${underscored('DETECT', 'ANOMALIES')})`, 'i'),
      new RegExp(`\\b${underscored('peak', 'rss')}_\\d+s\\b`),
      new RegExp(`\\b${underscored('duration')}_\\d+s\\b`),
      new RegExp(`\\b${underscored('behavior', 'anomaly')}_\\d+s\\b`),
      new RegExp(`\\b${underscored('run', 'early', 'features')}_\\d+s\\b`),
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

  it('keeps public docs and tests free of private provider release details', () => {
    const disallowedTerms = [
      predictiveEnv('URL'),
      predictiveEnv('AUTH_AUDIENCE'),
      predictiveEnv('TIMEOUT_MS'),
      joined('private', '.example'),
    ];
    const publicDocFiles = new Set([
      'README.md',
      'action.yaml',
      'frontend/public/index.html',
    ]);
    const docsAndTests = trackedFiles()
      .filter(file => repoFileExists(file))
      .filter(file => publicDocFiles.has(file) || file.endsWith('.md') || file.includes('__tests__/') || file.endsWith('_test.go'));

    const violations = docsAndTests.flatMap(file => {
      const contents = readRepoFile(file);
      return disallowedTerms
        .filter(term => contents.includes(term))
        .map(term => `${file}: ${term}`);
    });

    expect(violations).toEqual([]);
  });

  it('documents that relative-progress checkpoints need no public schema change', () => {
    const readme = readRepoFile('README.md');
    expect(readme).toContain('Relative-progress checkpoints (v2)');
    expect(readme).toContain('No public schema or dashboard change is required');
    expect(readme).toContain('observation_window_s');
    expect(readme).toContain('Legacy runs that omit `prediction_checkpoints` remain valid');

    const models = readRepoFile('backend/internal/models/models.go');
    expect(models).toContain('No additional public fields are required for relative-progress results');
    expect(models).not.toMatch(/\brelative_progress\b/);
    expect(models).not.toMatch(/\bprogress_(ratio|pct|percent)\b/);
  });
});
