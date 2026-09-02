import {
  parseMonitorLogLine,
  parseMonitorLogText,
  parseOptionalMetric,
} from '../src/lib/monitor_log';

describe('parseMonitorLogLine', () => {
  it('parses legacy 6-column rows', () => {
    const row = parseMonitorLogLine(
      '00:00:00 | 12345 | GradleDaemon | 100.0MB | 512.0MB | 256.0MB'
    );
    expect(row).toEqual({
      timestamp: '00:00:00',
      pid: '12345',
      name: 'GradleDaemon',
      heapUsedMb: '100.0',
      heapCapMb: '512.0',
      rssMb: '256.0',
      columnCount: 6,
      gcTimeRaw: undefined,
      optionalMetricRaws: [],
    });
  });

  it('parses legacy 7-column rows with GC time', () => {
    const row = parseMonitorLogLine(
      '00:00:05 | 1 | Proc | 10MB | 100MB | 50MB | 0.123s'
    );
    expect(row).toEqual({
      timestamp: '00:00:05',
      pid: '1',
      name: 'Proc',
      heapUsedMb: '10',
      heapCapMb: '100',
      rssMb: '50',
      columnCount: 7,
      gcTimeRaw: '0.123s',
      optionalMetricRaws: [],
    });
  });

  it('parses extended 14-column rows with JIT and class-loading metrics', () => {
    const row = parseMonitorLogLine(
      '00:00:05 | 1 | Proc | 10MB | 100MB | 50MB | 0.123s | 42 | 1 | 2 | 0.456 | 900 | 12 | 0.789'
    );
    expect(row).toEqual({
      timestamp: '00:00:05',
      pid: '1',
      name: 'Proc',
      heapUsedMb: '10',
      heapCapMb: '100',
      rssMb: '50',
      columnCount: 14,
      gcTimeRaw: '0.123s',
      optionalMetricRaws: ['42', '1', '2', '0.456', '900', '12', '0.789'],
    });
  });

  it('rejects malformed column counts', () => {
    expect(parseMonitorLogLine('')).toBeNull();
    expect(parseMonitorLogLine('a | b | c')).toBeNull();
    expect(parseMonitorLogLine('1 | 2 | 3 | 4 | 5 | 6 | 7 | 8')).toBeNull();
  });
});

describe('parseMonitorLogText', () => {
  it('skips the two header lines and keeps valid data rows', () => {
    const rows = parseMonitorLogText(
      'Elapsed_Time | PID | Name | Heap_Used_MB | Heap_Capacity_MB | RSS_MB\n' +
        '\n' +
        '00:00:00 | 12345 | GradleDaemon | 100.0MB | 512.0MB | 256.0MB\n' +
        'not-a-row\n' +
        '00:00:05 | 1 | Proc | 10MB | 100MB | 50MB | 0.123s\n'
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].columnCount).toBe(6);
    expect(rows[1].columnCount).toBe(7);
  });
});

describe('parseOptionalMetric', () => {
  it('parses finite values and treats missing or invalid cells as null', () => {
    expect(parseOptionalMetric('42')).toBe(42);
    expect(parseOptionalMetric('0.456s')).toBe(0.456);
    expect(parseOptionalMetric('0')).toBe(0);
    expect(parseOptionalMetric(undefined)).toBeNull();
    expect(parseOptionalMetric('')).toBeNull();
    expect(parseOptionalMetric('N/A')).toBeNull();
    expect(parseOptionalMetric('bad')).toBeNull();
  });
});
