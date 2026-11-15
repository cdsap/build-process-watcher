import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const publicDir = path.join(__dirname, '../frontend/public');

function readPublic(file: string): string {
  return fs.readFileSync(path.join(publicDir, file), 'utf8');
}

describe('replay re-render lifecycle', () => {
  const replaySource = readPublic('replay.js');

  it('destroys the prior clock and coalescer before rebinding on re-upload', () => {
    expect(replaySource).toContain('let stopReplay = null;');
    expect(replaySource).toMatch(/if \(typeof stopReplay === 'function'\) \{\s*stopReplay\(\);\s*stopReplay = null;\s*\}/);
    expect(replaySource).toMatch(/stopReplay = \(\) => \{\s*pause\(\);\s*coalescer\.cancel\(\);\s*clock\.destroy\(\);\s*\};/);
  });

  it('passes the shared buildReplayData result into studio and story init', () => {
    expect(replaySource).toMatch(/BpwChartStudio\.init\(\{\s*samples,\s*replayData: data,/);
    expect(replaySource).toMatch(/BpwBuildStory\.init\(\{\s*samples,\s*replayData: data,/);
    expect(replaySource.match(/buildReplayData\(/g) || []).toHaveLength(1);
  });
});

describe('shared replayData reuse in studio and story', () => {
  const samples = [
    { Timestamp: 1_000, PID: '1', Name: 'GradleDaemon', RSS: 10, Heap: 5 },
    { Timestamp: 2_000, PID: '1', Name: 'GradleDaemon', RSS: 12, Heap: 6 },
  ];
  const providedReplayData = {
    timestamps: [1_000, 2_000],
    series: {},
    totalRss: [10, 12],
  };

  function loadStudio(buildReplayData: jest.Mock) {
    const sandbox: any = {
      window: {},
      document: { getElementById: () => null },
      localStorage: {
        getItem: () => null,
        setItem: () => undefined,
      },
    };
    sandbox.window = sandbox;
    sandbox.global = sandbox;
    sandbox.BpwCompareShared = { buildReplayData };
    vm.runInNewContext(readPublic('chart-studio.js'), sandbox);
    return sandbox.BpwChartStudio;
  }

  function loadStory(buildReplayData: jest.Mock) {
    const sandbox: any = {
      window: {},
      document: { getElementById: () => null },
      localStorage: {
        getItem: () => null,
        setItem: () => undefined,
      },
    };
    sandbox.window = sandbox;
    sandbox.global = sandbox;
    sandbox.BpwCompareShared = { buildReplayData };
    vm.runInNewContext(readPublic('build-story.js'), sandbox);
    return sandbox.BpwBuildStory;
  }

  it('chart studio prefers provided replayData and skips rebuild', () => {
    const buildReplayData = jest.fn(() => ({ timestamps: [9], series: {} }));
    const studio = loadStudio(buildReplayData);
    studio.init({ samples, replayData: providedReplayData, runId: 'replay' });
    expect(buildReplayData).not.toHaveBeenCalled();
  });

  it('build story prefers provided replayData and skips rebuild', () => {
    const buildReplayData = jest.fn(() => ({ timestamps: [9], series: {} }));
    const story = loadStory(buildReplayData);
    story.init({ samples, replayData: providedReplayData, runId: 'replay' });
    expect(buildReplayData).not.toHaveBeenCalled();
  });

  it('chart studio still builds replayData when none is provided', () => {
    const buildReplayData = jest.fn(() => providedReplayData);
    const studio = loadStudio(buildReplayData);
    studio.init({ samples, runId: 'run' });
    expect(buildReplayData).toHaveBeenCalledTimes(1);
    expect(buildReplayData).toHaveBeenCalledWith(samples, [1_000, 2_000]);
  });
});
