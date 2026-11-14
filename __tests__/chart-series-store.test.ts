import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

function loadStore(): any {
  const sandbox: any = { module: { exports: {} }, exports: {} };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../frontend/public/chart-series-store.js'), 'utf8'),
    sandbox,
  );
  return sandbox.BpwChartSeriesStore || sandbox.module.exports;
}

describe('chart series store', () => {
  const api = loadStore();

  it('dedupes samples and reports append-only deltas', () => {
    const store = api.createChartSeriesStore([
      { Timestamp: 1000, Name: 'GradleDaemon', PID: '1', RSS: 10, HeapUsed: 5 },
      { Timestamp: 1000, Name: 'GradleDaemon', PID: '1', RSS: 10, HeapUsed: 5 },
    ]);
    expect(store.getCount()).toBe(1);
    const first = store.reconcile([
      { Timestamp: 1000, Name: 'GradleDaemon', PID: '1', RSS: 10, HeapUsed: 5 },
      { Timestamp: 2000, Name: 'GradleDaemon', PID: '1', RSS: 12, HeapUsed: 6 },
    ]);
    expect(first.appended).toHaveLength(1);
    expect(first.appended[0].Timestamp).toBe(2000);
    expect(first.unchanged).toBe(false);
    const second = store.reconcile([
      { Timestamp: 1000, Name: 'GradleDaemon', PID: '1', RSS: 10, HeapUsed: 5 },
      { Timestamp: 2000, Name: 'GradleDaemon', PID: '1', RSS: 12, HeapUsed: 6 },
    ]);
    expect(second.appended).toEqual([]);
    expect(second.unchanged).toBe(true);
  });
});
