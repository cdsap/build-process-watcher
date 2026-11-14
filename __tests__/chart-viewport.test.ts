import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

function loadViewport(): any {
  const sandbox: any = {
    module: { exports: {} },
    exports: {},
    setTimeout,
    clearTimeout,
    performance: { now: () => Date.now() },
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

  it('breaks measured series at unobserved gaps', () => {
    const timestamps = [0, 5_000, 10_000, 74_000];
    const values = [10, 20, 30, 90];
    const series = view.measuredSeriesWithGapBreaks(timestamps, values, 0, 3, 12_000);
    expect(series.x.map((d: Date) => d.getTime())).toEqual([0, 5_000, 10_000, 10_000, 74_000]);
    expect(series.y).toEqual([10, 20, 30, null, 90]);
  });

  it('progressively reveals dashed unobserved connectors across gaps', () => {
    const timestamps = [40_000, 44_000, 108_000];
    const values = [10, 20, 80];
    expect(view.unobservedConnectors(timestamps, values, 44_000, 12_000)).toEqual([]);
    expect(view.unobservedConnectors(timestamps, values, 76_000, 12_000, { maxIndex: 1 })).toEqual([
      {
        x: [44_000, 76_000],
        y: [20, 50],
        lowerIndex: 1,
        upperIndex: 2,
        complete: false,
      },
    ]);
    expect(view.unobservedConnectors(timestamps, values, 120_000, 12_000, { maxIndex: 2 })[0]).toMatchObject({
      x: [44_000, 108_000],
      y: [20, 80],
      complete: true,
    });
  });

  it('supports full and follow x domains', () => {
    const full = { min: 0, max: 100_000 };
    expect(view.followDomain(full, 20_000, 30_000, 'full')).toEqual({
      min: 0,
      max: 100_000,
      mode: 'full',
    });
    const follow = view.followDomain(full, 50_000, 30_000, 'follow');
    expect(follow.mode).toBe('follow');
    expect(follow.max - follow.min).toBe(30_000);
    expect(follow.min).toBeLessThanOrEqual(50_000);
    expect(follow.max).toBeGreaterThanOrEqual(50_000);
  });

  it('adds a vertical playhead shape', () => {
    const layout = view.applyPlayheadShape({ shapes: [] }, 12_500);
    expect(layout.shapes).toHaveLength(1);
    expect(layout.shapes[0].name).toBe('bpw-playhead');
    expect(layout.shapes[0].x0).toEqual(new Date(12_500));
  });

  it('waits for in-flight Plotly updates before starting the next', async () => {
    const calls: number[] = [];
    let now = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const coalescer = view.createRenderCoalescer({
      minIntervalMs: 0,
      now: () => now,
      schedule: (cb: Function) => setTimeout(cb, 0),
      render: async (payload: number) => {
        calls.push(payload);
        if (payload === 1) await gate;
      },
    });
    coalescer.enqueue(1);
    expect(calls).toEqual([1]);
    expect(coalescer.isInFlight()).toBe(true);
    coalescer.enqueue(2);
    coalescer.enqueue(3);
    expect(calls).toEqual([1]);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual([1, 3]);
    expect(coalescer.isInFlight()).toBe(false);
  });

  it('coalesces renders and keeps only the latest target', async () => {
    const calls: number[] = [];
    let now = 0;
    const coalescer = view.createRenderCoalescer({
      minIntervalMs: 50,
      now: () => now,
      schedule: (cb: Function, delay?: number) => setTimeout(cb, delay || 0),
      render: async (payload: number) => { calls.push(payload); },
    });
    coalescer.enqueue(1);
    expect(calls).toEqual([1]);
    coalescer.enqueue(2);
    coalescer.enqueue(3);
    now = 60;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls[calls.length - 1]).toBe(3);
    expect(calls).not.toContain(2);
  });
});
