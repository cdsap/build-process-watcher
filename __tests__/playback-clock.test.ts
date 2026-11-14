import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

function loadClock(): any {
  const root: any = {};
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../frontend/public/playback-clock.js'), 'utf8'),
    { module: { exports: {} }, globalThis: root, performance: { now: () => root.__now }, setTimeout, clearTimeout, matchMedia: () => ({ matches: false }) },
  );
  return root.BpwPlaybackClock || (module as any);
}

function loadClockDirect(): any {
  const sandbox: any = {
    module: { exports: {} },
    exports: {},
    performance: { now: () => sandbox.__now },
    setTimeout,
    clearTimeout,
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (cb: Function) => setTimeout(() => cb(sandbox.__now), 0),
    cancelAnimationFrame: clearTimeout,
  };
  sandbox.globalThis = sandbox;
  sandbox.__now = 0;
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../frontend/public/playback-clock.js'), 'utf8'),
    sandbox,
  );
  return { api: sandbox.BpwPlaybackClock || sandbox.module.exports, sandbox };
}

describe('playback clock', () => {
  it('advances by elapsed timestamps at 5x for a 23-sample run', () => {
    const { api, sandbox } = loadClockDirect();
    const timestamps = Array.from({ length: 23 }, (_, index) => 1_000_000 + index * 5_000);
    const positions: number[] = [];
    const clock = api.createPlaybackClock({
      timestamps,
      speed: 5,
      now: () => sandbox.__now,
      requestAnimationFrame: (cb: Function) => {
        sandbox.__raf = cb;
        return 1;
      },
      cancelAnimationFrame: () => { sandbox.__raf = null; },
      onPosition: (position: any) => positions.push(position.cursorMs),
    });

    expect(clock.getState().durationMs).toBe(22 * 5_000);
    clock.play();
    sandbox.__now = 1_000; // 1s wall => 5s logical
    sandbox.__raf(sandbox.__now);
    expect(clock.getState().cursorMs).toBe(5_000);
    expect(clock.getState().sampleIndex).toBe(1);

    clock.setSpeed(50);
    sandbox.__now = 1_200; // +0.2s wall at 50x => +10s logical
    sandbox.__raf(sandbox.__now);
    expect(clock.getState().cursorMs).toBe(15_000);

    clock.seekTo(110_000);
    expect(clock.getState().cursorMs).toBe(110_000);
    expect(clock.getState().playing).toBe(true);
    sandbox.__now = 1_400;
    sandbox.__raf(sandbox.__now);
    expect(clock.getState().playing).toBe(false);
    expect(clock.getState().cursorMs).toBe(110_000);
    expect(positions.length).toBeGreaterThan(3);
  });

  it('preserves cursor across pause and speed changes', () => {
    const { api, sandbox } = loadClockDirect();
    const timestamps = [0, 10_000, 20_000];
    const clock = api.createPlaybackClock({
      timestamps,
      speed: 10,
      now: () => sandbox.__now,
      requestAnimationFrame: (cb: Function) => {
        sandbox.__raf = cb;
        return 1;
      },
      cancelAnimationFrame: () => { sandbox.__raf = null; },
    });
    clock.play();
    sandbox.__now = 500;
    sandbox.__raf(sandbox.__now);
    expect(clock.getState().cursorMs).toBe(5_000);
    clock.pause();
    expect(clock.getState().playing).toBe(false);
    expect(clock.getState().cursorMs).toBe(5_000);
    clock.setSpeed(2);
    clock.play();
    sandbox.__now = 1_000;
    sandbox.__raf(sandbox.__now);
    expect(clock.getState().cursorMs).toBe(6_000);
  });

  it('binary-searches sample indices on irregular timestamps', () => {
    const { api } = loadClockDirect();
    expect(api.lowerBoundIndex([0, 5, 10, 30], 10)).toBe(2);
    expect(api.lowerBoundIndex([0, 5, 10, 30], 11)).toBe(3);
    const clock = api.createPlaybackClock({
      timestamps: [100, 600, 5600, 10_600],
      speed: 1,
      now: () => 0,
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => {},
    });
    clock.seekTo(500);
    expect(clock.getState().sampleIndex).toBe(1);
    clock.seekTo(5_500);
    expect(clock.getState().sampleIndex).toBe(2);
  });
});
