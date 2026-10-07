import { parseLogContents } from '../src/cleanup';

const headers = 'Elapsed_Time | PID | Name | Heap_Used_MB | Heap_Capacity_MB | RSS_MB\n\n';

describe('parseLogContents', () => {
  it('parses legacy 6-column records', () => {
    const result = parseLogContents(
      headers + '00:00:05 | 1 | Proc | 10MB | 100MB | 50MB\n'
    );

    expect(result.hasGcData).toBe(false);
    expect(result.hasJitData).toBe(false);
    expect(result.hasClassData).toBe(false);
    expect(result.timestamps).toEqual(['00:00:05']);
    expect(result.processes.get('1-Proc')).toMatchObject({
      timestamps: ['00:00:05'],
      rss: [50],
      heapUsed: [10],
      heapCap: [100],
      gcTime: [0],
      gcAvailable: [false],
      jitCompiledMethods: [null],
      jitFailedCompilations: [null],
      classesLoaded: [null],
      classesUnloaded: [null],
    });
  });

  it('preserves GC availability for 7-column records', () => {
    const result = parseLogContents(
      headers + '00:00:05 | 1 | Proc | 10MB | 100MB | 50MB | 0.123s\n'
    );

    expect(result.hasGcData).toBe(true);
    expect(result.processes.get('1-Proc')?.gcTime).toEqual([0.123]);
    expect(result.processes.get('1-Proc')?.gcAvailable).toEqual([true]);
  });

  it('parses optional metrics and orders timestamps independently of input order', () => {
    const result = parseLogContents(
      headers +
        '00:00:10 | 1 | Proc | 20MB | 200MB | 60MB | 0.2s | 42 | 1 | 2 | 0.3s | 900 | 12 | 0.4s\n' +
        '00:00:02 | 1 | Proc | 10MB | 100MB | 50MB | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A\n'
    );

    expect(result.timestamps).toEqual(['00:00:02', '00:00:10']);
    expect(result.hasGcData).toBe(true);
    expect(result.hasJitData).toBe(true);
    expect(result.hasClassData).toBe(true);
    expect(result.processes.get('1-Proc')).toMatchObject({
      timestamps: ['00:00:10', '00:00:02'],
      jitCompiledMethods: [42, null],
      jitFailedCompilations: [1, null],
      classesLoaded: [900, null],
      classesUnloaded: [12, null],
      gcTime: [0.2, 0],
      gcAvailable: [true, false],
    });
  });
});
