import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

function loadViewport(): any {
  const sandbox: any = {
    module: { exports: {} },
    exports: {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../frontend/public/chart-viewport.js'), 'utf8'),
    sandbox,
  );
  return sandbox.BpwChartViewport || sandbox.module.exports;
}

describe('chart viewport', () => {
  const view = loadViewport();

  it('keeps replay domains fixed and nice-ceiled', () => {
    expect(view.niceCeil(1270, 1.10)).toBe(1500);
    expect(view.memoryDomain([100, 1270, 800])).toEqual({ min: 0, max: 1500 });
    expect(view.timeDomain([1_000, 11_000], 0.02)).toEqual({ min: 800, max: 11_200 });
    const layout = view.applyFixedRanges({ title: 'Memory' }, {
      x: { min: 0, max: 10 },
      y: { min: 0, max: 1500 },
      uirevision: 'run:test:memory',
    });
    expect(layout.xaxis.autorange).toBe(false);
    expect(layout.yaxis.range).toEqual([0, 1500]);
    expect(layout.uirevision).toBe('run:test:memory');
  });

  it('creates presentation-only visual endpoints without crossing gaps', () => {
    const timestamps = [0, 5_000, 10_000, 40_000];
    const values = [10, 20, 30, 40];
    expect(view.visualEndpoint(timestamps, values, 7_500, 12_000)).toEqual({
      time: 7_500,
      value: 25,
      visualOnly: true,
      lowerIndex: 1,
      upperIndex: 2,
    });
    expect(view.visualEndpoint(timestamps, values, 20_000, 12_000)).toBeNull();
    expect(view.visualEndpoint(timestamps, values, 5_000, 12_000)).toBeNull();
  });

  it('coalesces renders and keeps only the latest target', async () => {
    const calls: number[] = [];
    let now = 0;
    const coalescer = view.createRenderCoalescer({
      minIntervalMs: 50,
      now: () => now,
      schedule: (cb: Function) => setTimeout(cb, 0),
      render: async (payload: number) => { calls.push(payload); },
    });
    coalescer.enqueue(1);
    expect(calls).toEqual([1]);
    coalescer.enqueue(2);
    coalescer.enqueue(3);
    now = 60;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls[calls.length - 1]).toBe(3);
    expect(calls).not.toContain(2);
  });
});
