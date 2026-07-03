import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { artifactSummary, existingArtifactPaths } from '../src/lib/artifacts';

describe('existingArtifactPaths', () => {
  it('returns absolute paths for every generated chart that exists', () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpw-artifacts-'));
    const chartNames = [
      'memory_usage-run-1.svg',
      'gc_time-run-1.svg',
      'jit_compilation-run-1.svg',
      'class_loading-run-1.svg',
    ];

    try {
      chartNames.forEach(name => fs.writeFileSync(path.join(outputDir, name), '<svg/>'));

      const files = existingArtifactPaths(chartNames.map(name => path.join(outputDir, name)));

      expect(files).toEqual(chartNames.map(name => path.join(outputDir, name)));
      expect(files.every(path.isAbsolute)).toBe(true);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('omits optional artifacts that were not generated', () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpw-artifacts-'));
    const memoryChart = path.join(outputDir, 'memory_usage-run-1.svg');

    try {
      fs.writeFileSync(memoryChart, '<svg/>');

      expect(existingArtifactPaths([
        memoryChart,
        path.join(outputDir, 'jit_compilation-run-1.svg'),
      ])).toEqual([memoryChart]);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });
});

describe('artifactSummary', () => {
  it('confirms the exact charts archived by a successful upload', () => {
    const files = [
      '/tmp/build_process_watcher-run-1.log',
      '/tmp/memory_usage-run-1.svg',
      '/tmp/gc_time-run-1.svg',
      '/tmp/jit_compilation-run-1.svg',
      '/tmp/class_loading-run-1.svg',
    ];

    expect(artifactSummary('build_process_watcher-test-1', files)).toBe(
      '> Archived 5 result files in artifact `build_process_watcher-test-1`. Charts: ' +
      '`memory_usage-run-1.svg`, `gc_time-run-1.svg`, `jit_compilation-run-1.svg`, ' +
      '`class_loading-run-1.svg`.',
    );
  });
});
