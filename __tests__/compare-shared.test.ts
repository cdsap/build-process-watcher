import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

function loadShared(): any {
  const window: any = { innerWidth: 1200 };
  const context = vm.createContext({ window, document: {}, localStorage: { getItem: () => null } });
  const source = fs.readFileSync(path.join(__dirname, '../frontend/public/compare-shared.js'), 'utf8');
  vm.runInContext(source, context);
  return window.BpwCompareShared;
}

describe('JIT and class loading series', () => {
  const shared = loadShared();

  it('detects real zero values but not missing metrics', () => {
    expect(shared.hasJITData([{ JITCompiledMethods: 0 }])).toBe(true);
    expect(shared.hasJITData([{}])).toBe(false);
    expect(shared.hasClassLoadingData([{ ClassesLoaded: 0 }])).toBe(true);
  });

  it('calculates rates across actual sparse observations', () => {
    const timestamps = [0, 1000, 2000, 5000];
    const samples = [
      { Timestamp: 0, Name: 'P', PID: '1', ClassesLoaded: 10 },
      { Timestamp: 1000, Name: 'P', PID: '1', ClassesLoaded: null },
      { Timestamp: 5000, Name: 'P', PID: '1', ClassesLoaded: 30 },
    ];
    const result = shared.buildCounterSeries(samples, timestamps, 'P', '1', (s: any) => s.ClassesLoaded);
    expect(Array.from(result.cumulative)).toEqual([10, 10, 10, 30]);
    expect(Array.from(result.rate)).toEqual([null, null, null, 4]);
  });

  it('breaks a rate segment when a counter decreases and isolates PIDs', () => {
    const samples = [
      { Timestamp: 0, Name: 'P', PID: '1', JITCompiledMethods: 10 },
      { Timestamp: 1000, Name: 'P', PID: '2', JITCompiledMethods: 100 },
      { Timestamp: 2000, Name: 'P', PID: '1', JITCompiledMethods: 5 },
      { Timestamp: 3000, Name: 'P', PID: '1', JITCompiledMethods: 9 },
    ];
    const result = shared.buildCounterSeries(samples, [0, 1000, 2000, 3000], 'P', '1', (s: any) => s.JITCompiledMethods);
    expect(Array.from(result.rate)).toEqual([null, null, null, 4]);
  });
});
