import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  loadProcessInfoFromFile,
  generateJsonReport,
  parseTimestampSeconds,
} from '../src/lib/report';

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

  it('ignores malformed lines and handles invalid JSON', () => {
    const logFile = path.join(tmpDir, 'test.log');
    const processInfoFile = path.join(tmpDir, 'test.process_info');
    fs.writeFileSync(logFile, 'header\n');
    fs.writeFileSync(
      processInfoFile,
      '12345\tGradleDaemon\t["-XX:flag"]\n' +
        'invalid-line\n' +
        '\n' +
        '999\tName\tinvalid-json\n'
    );

    const result = loadProcessInfoFromFile(logFile);
    expect(result['12345']).toEqual({ name: 'GradleDaemon', vm_flags: ['-XX:flag'] });
    // Invalid JSON yields empty vm_flags but line is still parsed
    expect(result['999']).toEqual({ name: 'Name', vm_flags: [] });
    // Lines without proper tab format are skipped
    expect(Object.keys(result)).toHaveLength(2);
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

    const output = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
    expect(output.finished).toBe(true);
    expect(output.samples).toHaveLength(2);
    expect(output.samples[0]).toMatchObject({
      PID: '12345',
      Name: 'GradleDaemon',
      RSS: 256,
      HeapUsed: 100,
      HeapCap: 512,
    });
    expect(output.process_info['12345']).toEqual({
      name: 'GradleDaemon',
      vm_flags: ['-XX:MaxHeapSize=2048m', '-XX:+UseG1GC'],
    });
  });

  it('generates JSON with empty vm_flags when process_info is missing', () => {
    const logFile = path.join(tmpDir, 'test.log');
    const outputFile = path.join(tmpDir, 'output.json');

    fs.writeFileSync(
      logFile,
      'Elapsed_Time | PID | Name | Heap_Used_MB | Heap_Capacity_MB | RSS_MB\n' +
        '\n' +
        '00:00:00 | 999 | SomeProcess | 50.0MB | 256.0MB | 128.0MB\n'
    );

    generateJsonReport(logFile, outputFile, false);

    const output = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
    expect(output.process_info['999']).toEqual({
      name: 'SomeProcess',
      vm_flags: [],
    });
  });

  it('includes GC data when hasGcData is true', () => {
    const logFile = path.join(tmpDir, 'test.log');
    const outputFile = path.join(tmpDir, 'output.json');

    fs.writeFileSync(
      logFile,
      'Elapsed_Time | PID | Name | Heap_Used_MB | Heap_Capacity_MB | RSS_MB | GC_Time_S\n' +
        '\n' +
        '00:00:00 | 1 | Proc | 10MB | 100MB | 50MB | 0.123s\n'
    );

    generateJsonReport(logFile, outputFile, true);

    const output = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
    expect(output.samples[0].GCTime).toBe(123);
    expect(output.samples[0].GCTimeSeconds).toBe(0.123);
  });

  it('parses extended JIT and class loading metrics', () => {
    const logFile = path.join(tmpDir, 'test.log');
    const outputFile = path.join(tmpDir, 'output.json');
    fs.writeFileSync(logFile,
      'header\n\n' +
      '00:00:05 | 1 | Proc | 10MB | 100MB | 50MB | 0.123s | 42 | 1 | 2 | 0.456 | 900 | 12 | 0.789\n');

    generateJsonReport(logFile, outputFile, true);
    const sample = JSON.parse(fs.readFileSync(outputFile, 'utf8')).samples[0];

    expect(sample).toMatchObject({
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
    const logFile = path.join(tmpDir, 'test.log');
    const outputFile = path.join(tmpDir, 'output.json');
    fs.writeFileSync(logFile,
      'header\n\n' +
      '00:00:05 | 1 | Proc | 10MB | 100MB | 50MB | N/A | N/A | bad | N/A | N/A | 0 | N/A | broken\n');

    generateJsonReport(logFile, outputFile, true);
    const sample = JSON.parse(fs.readFileSync(outputFile, 'utf8')).samples[0];

    expect(sample.RSS).toBe(50);
    expect(sample.GCTime).toBeNull();
    expect(sample.JITCompiledMethods).toBeNull();
    expect(sample.JITFailedCompilations).toBeNull();
    expect(sample.ClassesLoaded).toBe(0);
    expect(sample.ClassLoadTimeMs).toBeNull();
  });
});
