import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  loadProcessInfoFromFile,
  buildJsonReport,
  generateJsonReport,
  parseTimestampSeconds,
} from '../src/lib/report';
import { parseLogSample, parseLogSamples } from '../src/lib/log_samples';
import { parseProcessInfo } from '../src/lib/process_info';

describe('log sample parser', () => {
  it.each([6, 7, 14])('accepts %s-column records', columnCount => {
    const suffix = columnCount === 6
      ? ''
      : columnCount === 7
        ? ' | 0.123s'
        : ' | 0.123s | 42 | 1 | 2 | 0.456 | 900 | 12 | 0.789';
    const sample = parseLogSample(`00:00:05 | 1 | Proc | 10MB | 100MB | 50MB${suffix}`);

    expect(sample?.columnCount).toBe(columnCount);
    expect(sample?.heapUsedMb).toBe(10);
    expect(sample?.heapCapMb).toBe(100);
    expect(sample?.rssMb).toBe(50);
  });

  it('normalizes numeric and unavailable optional metrics', () => {
    const sample = parseLogSample(
      '00:00:05 | 1 | Proc | 10MB | 100MB | 50MB | N/A | N/A | bad | N/A | N/A | 0 | N/A | broken'
    );

    expect(sample).toMatchObject({
      gcTimeSeconds: null,
      jitCompiledMethods: null,
      jitFailedCompilations: null,
      jitInvalidatedCompilations: null,
      jitCompilationTimeSeconds: null,
      classesLoaded: 0,
      classesUnloaded: null,
      classLoadTimeSeconds: null,
    });
  });

  it('skips malformed records while parsing log text', () => {
    expect(parseLogSamples('header\n\nnot-a-row\n1 | 2 | 3')).toEqual([]);
  });
});

describe('parseTimestampSeconds', () => {
  it('parses HH:MM:SS format', () => {
    expect(parseTimestampSeconds('00:00:00')).toBe(0);
    expect(parseTimestampSeconds('00:01:30')).toBe(90);
    expect(parseTimestampSeconds('01:00:00')).toBe(3600);
    expect(parseTimestampSeconds('00:03:23')).toBe(203);
  });

  it('parses numeric seconds', () => {
    expect(parseTimestampSeconds('0')).toBe(0);
    expect(parseTimestampSeconds('300')).toBe(300);
    expect(parseTimestampSeconds('123.5')).toBe(123.5);
  });

  it('returns 0 for invalid input', () => {
    expect(parseTimestampSeconds('')).toBe(0);
    expect(parseTimestampSeconds('invalid')).toBe(0);
  });
});

describe('parseProcessInfo', () => {
  it('parses valid records and trims surrounding whitespace', () => {
    expect(parseProcessInfo(
      ' 12345 \t GradleDaemon \t ["-XX:MaxHeapSize=2048m","-XX:+UseG1GC"] \r\n' +
        '67890\tKotlinCompileDaemon\t["-XX:MaxHeapSize=512m"]\n'
    )).toEqual({
      '12345': {
        name: 'GradleDaemon',
        vm_flags: ['-XX:MaxHeapSize=2048m', '-XX:+UseG1GC'],
      },
      '67890': { name: 'KotlinCompileDaemon', vm_flags: ['-XX:MaxHeapSize=512m'] },
    });
  });

  it('skips blank and malformed lines', () => {
    expect(parseProcessInfo(
      '\n \t \r\ninvalid-line\n123\tName\n' +
        ' \tName\t[]\n456\t \t[]\n' +
        '789\tValid\t[]\n'
    )).toEqual({ '789': { name: 'Valid', vm_flags: [] } });
    expect(parseProcessInfo('')).toEqual({});
  });

  it.each(['invalid-json', '{"flag":true}', 'null', '42', '"flag"', 'true'])(
    'uses empty vm_flags for invalid or non-array JSON: %s', vmFlagsJson => {
      expect(parseProcessInfo(`999\tName\t${vmFlagsJson}\n`)).toEqual({
        '999': { name: 'Name', vm_flags: [] },
      });
    }
  );

  it('accepts JSON arrays without filtering their elements', () => {
    expect(parseProcessInfo('123\tName\t["-XX:flag",42,null,{"flag":true}]')).toEqual({
      '123': { name: 'Name', vm_flags: ['-XX:flag', 42, null, { flag: true }] },
    });
  });

  it('overwrites repeated PIDs with the last valid record', () => {
    expect(parseProcessInfo(
      '123\tFirst\t["-XX:flag"]\n' +
        '123\tLast\tinvalid-json\n' +
        '123\t \t[]\n'
    )).toEqual({ '123': { name: 'Last', vm_flags: [] } });
  });
});

describe('loadProcessInfoFromFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty object when process_info file does not exist', () => {
    const logFile = path.join(tmpDir, 'test.log');
    fs.writeFileSync(logFile, 'header\n');
    expect(loadProcessInfoFromFile(logFile)).toEqual({});
  });

  it('parses process_info file with vm_flags', () => {
    const logFile = path.join(tmpDir, 'build_process_watcher.log');
    const processInfoFile = path.join(tmpDir, 'build_process_watcher.process_info');
    fs.writeFileSync(logFile, 'header\n');
    fs.writeFileSync(
      processInfoFile,
      '12345\tGradleDaemon\t["-XX:MaxHeapSize=2048m","-XX:+UseG1GC"]\n' +
        '67890\tKotlinCompileDaemon\t["-XX:MaxHeapSize=512m"]\n'
    );

    const result = loadProcessInfoFromFile(logFile);
    expect(result['12345']).toEqual({
      name: 'GradleDaemon',
      vm_flags: ['-XX:MaxHeapSize=2048m', '-XX:+UseG1GC'],
    });
    expect(result['67890']).toEqual({
      name: 'KotlinCompileDaemon',
      vm_flags: ['-XX:MaxHeapSize=512m'],
    });
  });

  it('returns empty object when process_info cannot be read as a file', () => {
    const logFile = path.join(tmpDir, 'test.log');
    fs.mkdirSync(path.join(tmpDir, 'test.process_info'));
    expect(loadProcessInfoFromFile(logFile)).toEqual({});
  });
});

describe('generateJsonReport', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('generates JSON with samples and process_info', () => {
    const logFile = path.join(tmpDir, 'build_process_watcher.log');
    const processInfoFile = path.join(tmpDir, 'build_process_watcher.process_info');
    const outputFile = path.join(tmpDir, 'output.json');

    fs.writeFileSync(
      logFile,
      'Elapsed_Time | PID | Name | Heap_Used_MB | Heap_Capacity_MB | RSS_MB\n' +
        '\n' + // second header line (cleanup skips first 2 lines)
        '00:00:00 | 12345 | GradleDaemon | 100.0MB | 512.0MB | 256.0MB\n' +
        '00:00:05 | 12345 | GradleDaemon | 120.0MB | 512.0MB | 280.0MB\n'
    );
    fs.writeFileSync(
      processInfoFile,
      '12345\tGradleDaemon\t["-XX:MaxHeapSize=2048m","-XX:+UseG1GC"]\n'
    );

    generateJsonReport(logFile, outputFile, false);

    const outputText = fs.readFileSync(outputFile, 'utf8');
    const output = JSON.parse(outputText);
    expect(outputText).toBe(JSON.stringify(buildJsonReport(
      fs.readFileSync(logFile, 'utf8'),
      { '12345': { name: 'GradleDaemon', vm_flags: ['-XX:MaxHeapSize=2048m', '-XX:+UseG1GC'] } },
      false
    ), null, 2));
    expect(output.finished).toBe(true);
    expect(output.samples).toHaveLength(2);
    expect(output.sample_fields).toEqual([
      'Timestamp', 'ElapsedTime', 'PID', 'Name', 'RSS', 'HeapUsed', 'HeapCap',
      'GCTime', 'GCTimeSeconds', 'JITCompiledMethods', 'JITFailedCompilations',
      'JITInvalidatedCompilations', 'JITCompilationTimeMs', 'ClassesLoaded',
      'ClassesUnloaded', 'ClassLoadTimeMs',
    ]);
    expect(output.samples[0]).toEqual([
      0, 0, '12345', 'GradleDaemon', 256, 100, 512,
      null, null, null, null, null, null, null, null, null,
    ]);
    expect(output.process_info['12345']).toEqual({
      name: 'GradleDaemon',
      vm_flags: ['-XX:MaxHeapSize=2048m', '-XX:+UseG1GC'],
    });
  });

  it('writes a report when the process_info sidecar is missing', () => {
    const logFile = path.join(tmpDir, 'test.log');
    const outputFile = path.join(tmpDir, 'output.json');
    fs.writeFileSync(logFile, 'header\n\n0 | 999 | Proc | 10MB | 100MB | 50MB\n');

    generateJsonReport(logFile, outputFile, false);

    const output = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
    expect(output.process_info).toEqual({ '999': { name: 'Proc', vm_flags: [] } });
    expect(output.samples).toHaveLength(1);
    expect(output.finished).toBe(true);
  });

  it('propagates log read errors', () => {
    expect(() => generateJsonReport(
      path.join(tmpDir, 'missing.log'), path.join(tmpDir, 'output.json'), false
    )).toThrow(/ENOENT/);
  });

  it('propagates output write errors', () => {
    const logFile = path.join(tmpDir, 'test.log');
    fs.writeFileSync(logFile, 'header\n\n');
    expect(() => generateJsonReport(logFile, tmpDir, false)).toThrow(/EISDIR/);
  });
});

describe('buildJsonReport', () => {
  it('merges flags for sampled processes without mutating supplied metadata', () => {
    const processInfo = {
      '1': { name: 'SidecarName', vm_flags: ['-XX:+UseG1GC'] },
      '2': { name: 'Unsampled', vm_flags: ['-Xmx1g'] },
    };
    Object.values(processInfo).forEach(info => {
      Object.freeze(info.vm_flags);
      Object.freeze(info);
    });
    Object.freeze(processInfo);

    const output = buildJsonReport(
      'header\n\n' +
      '0 | 1 | FirstName | 10MB | 100MB | 50MB\n' +
      '5 | 1 | LaterName | 20MB | 100MB | 60MB\n' +
      '5 | 3 | NoMetadata | 20MB | 100MB | 60MB\n',
      processInfo, false
    );

    expect(output.process_info).toEqual({
      '1': { name: 'FirstName', vm_flags: ['-XX:+UseG1GC'] },
      '3': { name: 'NoMetadata', vm_flags: [] },
    });
    expect(output.samples[1][3]).toBe('LaterName');
    expect(processInfo).toEqual({
      '1': { name: 'SidecarName', vm_flags: ['-XX:+UseG1GC'] },
      '2': { name: 'Unsampled', vm_flags: ['-Xmx1g'] },
    });
  });

  it('skips exactly two header lines and malformed rows, preserving base metric fallbacks', () => {
    const output = buildJsonReport(
      '0 | 1 | HeaderOne | 1MB | 2MB | 3MB\n' +
      '0 | 2 | HeaderTwo | 1MB | 2MB | 3MB\n' +
      '\nnot-a-row\n1 | 2 | 3\n' +
      '-5 | 3 | Proc | bad | N/A | broken\n' +
      '1.5 | 3 | Proc | 10MB | 100MB | 50MB\n',
      {}, true
    );

    expect(output.samples).toEqual([
      [0, 0, '3', 'Proc', 0, 0, 0, null, null, null, null, null, null, null, null, null],
      [1500, 1.5, '3', 'Proc', 50, 10, 100, null, null, null, null, null, null, null, null, null],
    ]);
    expect(output.process_info).toEqual({ '3': { name: 'Proc', vm_flags: [] } });
  });

  it('builds a finished empty report when no samples are present', () => {
    const output = buildJsonReport('', { '1': { name: 'Unsampled', vm_flags: [] } }, true);

    expect(output.samples).toEqual([]);
    expect(output.process_info).toEqual({});
    expect(output.finished).toBe(true);
  });

  it('builds legacy samples with empty vm_flags when process metadata is missing', () => {
    const output = buildJsonReport(
      'Elapsed_Time | PID | Name | Heap_Used_MB | Heap_Capacity_MB | RSS_MB\n' +
        '\n' +
        '00:00:00 | 999 | SomeProcess | 50.0MB | 256.0MB | 128.0MB\n',
      {}, false
    );

    expect(Object.keys(output)).toEqual(['sample_fields', 'samples', 'process_info', 'finished']);
    expect(output.finished).toBe(true);
    expect(output.samples).toEqual([[
      0, 0, '999', 'SomeProcess', 128, 50, 256,
      null, null, null, null, null, null, null, null, null,
    ]]);
    expect(output.process_info['999']).toEqual({
      name: 'SomeProcess',
      vm_flags: [],
    });
  });

  it.each([true, false])('gates GC data with hasGcData=%s', hasGcData => {
    const output = buildJsonReport(
      'Elapsed_Time | PID | Name | Heap_Used_MB | Heap_Capacity_MB | RSS_MB | GC_Time_S\n' +
        '\n' +
        '00:00:00 | 1 | Proc | 10MB | 100MB | 50MB | 0.123s\n',
      {}, hasGcData
    );

    const sample = Object.fromEntries(output.sample_fields.map((field: string, index: number) => [field, output.samples[0][index]]));
    expect(sample.GCTime).toBe(hasGcData ? 123 : null);
    expect(sample.GCTimeSeconds).toBe(hasGcData ? 0.123 : null);
  });

  it.each([true, false])('parses extended JIT and class loading metrics with hasGcData=%s', hasGcData => {
    const output = buildJsonReport(
      'header\n\n' +
      '00:00:05 | 1 | Proc | 10MB | 100MB | 50MB | 0.123s | 42 | 1 | 2 | 0.456 | 900 | 12 | 0.789\n',
      {}, hasGcData
    );
    const sample = Object.fromEntries(output.sample_fields.map((field: string, index: number) => [field, output.samples[0][index]]));

    expect(sample).toMatchObject({
      Timestamp: 5000,
      ElapsedTime: 5,
      GCTime: hasGcData ? 123 : null,
      GCTimeSeconds: hasGcData ? 0.123 : null,
      JITCompiledMethods: 42,
      JITFailedCompilations: 1,
      JITInvalidatedCompilations: 2,
      JITCompilationTimeMs: 456,
      ClassesLoaded: 900,
      ClassesUnloaded: 12,
      ClassLoadTimeMs: 789,
    });
  });

  it('keeps the base sample when optional metrics are unavailable or malformed', () => {
    const output = buildJsonReport(
      'header\n\n' +
      '00:00:05 | 1 | Proc | 10MB | 100MB | 50MB | N/A | N/A | bad | N/A | N/A | 0 | N/A | broken\n',
      {}, true
    );

    expect(output.samples).toEqual([[
      5000, 5, '1', 'Proc', 50, 10, 100,
      null, null, null, null, null, null, 0, null, null,
    ]]);
  });
});


describe('metric measurement report compatibility', () => {
  it('preserves timing records for matching log rows through packed JSON export', () => {
    const line = '00:00:05 | 42 | GradleDaemon | 10MB | 100MB | 50MB | 0s | 20 | 0 | 0 | 1 | 100 | 0 | 1';
    const log = 'Session started\nheader\n' + line + '\n';
    const times = { process_start_time_ms: 1000, jit_sampled_at_ms: 5100, classes_sampled_at_ms: 5200 };
    const report = buildJsonReport(log, {}, true, [{ data: line, metric_measurements: times }]);
    const column = report.sample_fields.indexOf('MetricMeasurements' as any);
    expect(column).toBeGreaterThan(-1);
    expect(report.samples[0][column]).toEqual(times);
    const unknown = buildJsonReport(log, {}, true, []);
    expect(unknown.samples[0][column]).toEqual({});
    expect(buildJsonReport(log, {}, true).sample_fields).not.toContain('MetricMeasurements');
  });
});

it('keeps reports usable when a metric sidecar ends with an incomplete record', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bpw-timing-report-'));
  const log = path.join(directory, 'metrics.log');
  const output = path.join(directory, 'report.json');
  try {
    fs.writeFileSync(log, 'Session\nheader\n00:00:01 | 42 | P | 1MB | 2MB | 3MB\n');
    fs.writeFileSync(log + '.measurements.jsonl', '{"data":');
    generateJsonReport(log, output, false);
    const report = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(report.samples).toHaveLength(1);
    expect(report.samples[0][report.sample_fields.indexOf('MetricMeasurements')]).toEqual({});
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
