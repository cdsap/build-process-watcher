import { resolveRunIdentity } from '../src/lib/run_identity';

describe('resolveRunIdentity', () => {
  it('uses the environment run ID first', () => {
    expect(resolveRunIdentity({
      environmentRunId: 'run-1',
      backupFiles: ['/tmp/run-id'],
      debugLogFile: '/tmp/debug.log',
      githubRunId: 'build-2',
      readFile: () => 'run-3',
    })).toEqual({ runId: 'run-1', source: 'environment' });
  });

  it('reads the first available backup file', () => {
    expect(resolveRunIdentity({
      backupFiles: ['/tmp/missing', '/tmp/run-id'],
      readFile: file => file === '/tmp/run-id' ? 'run-2\n' : (() => { throw new Error('missing'); })(),
    })).toEqual({ runId: 'run-2', source: 'backup-file' });
  });

  it('extracts a run ID from the debug log', () => {
    expect(resolveRunIdentity({
      debugLogFile: '/tmp/debug.log',
      readFile: () => 'Run ID: build-3',
    })).toEqual({ runId: 'build-3', source: 'debug-log' });
  });

  it('uses a valid GitHub run ID as the last fallback', () => {
    expect(resolveRunIdentity({ githubRunId: 'run-4' }))
      .toEqual({ runId: 'run-4', source: 'github-run' });
  });

  it('ignores an invalid GitHub run ID', () => {
    expect(resolveRunIdentity({ githubRunId: '1234' })).toEqual({});
  });

  it('returns no identity when every candidate is missing', () => {
    expect(resolveRunIdentity({
      backupFiles: ['/tmp/missing'],
      debugLogFile: '/tmp/debug.log',
      readFile: () => { throw new Error('missing'); },
    })).toEqual({});
  });
});
