import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

function loadReplayStack() {
  const sandbox: any = {
    module: { exports: {} },
    exports: {},
    performance: { now: () => sandbox.__now },
    setTimeout,
    clearTimeout,
    matchMedia: () => ({ matches: false }),
    requestAnimationFrame: (cb: Function) => setTimeout(() => cb(sandbox.__now), 0),
    cancelAnimationFrame: clearTimeout,
    document: {
      querySelector: () => null,
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.__now = 0;

  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../frontend/public/playback-clock.js'), 'utf8'),
    sandbox,
  );
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../frontend/public/replay-controls.js'), 'utf8'),
    sandbox,
  );
  return sandbox;
}

describe('shared replay controls', () => {
  it('renders a stable control shell with prefixed ids', () => {
    const sandbox = loadReplayStack();
    const html = sandbox.BpwReplayControls.renderReplayControls({
      idPrefix: 'forecast-replay',
      className: 'forecast-replay-controls',
      defaultSpeed: 15,
      speeds: [5, 15, 50],
    });
    expect(html).toContain('id="forecast-replay-controls"');
    expect(html).toContain('id="btn-forecast-replay-play"');
    expect(html).toContain('id="forecast-replay-timeline"');
    expect(html).toContain('class="replay-controls forecast-replay-controls"');
    expect(html).toContain('<option value="15" selected>15x</option>');
  });

  it('binds playhead scrubbing through BpwPlaybackClock', () => {
    const sandbox = loadReplayStack();
    const byId = new Map<string, any>();
    const makeEl = (overrides: Record<string, any> = {}) => {
      const el: any = {
        value: '',
        textContent: '',
        listeners: {} as Record<string, Function>,
        addEventListener: jest.fn((eventName: string, handler: Function) => {
          el.listeners[eventName] = handler;
        }),
        querySelector: (selector: string) => {
          const idMatch = selector.match(/^#(.+)$/);
          return idMatch ? byId.get(idMatch[1]) || null : null;
        },
        ...overrides,
      };
      return el;
    };

    const timestamps = [1000, 5000, 11000];
    byId.set('forecast-replay-timeline', makeEl({ value: '0' }));
    byId.set('forecast-replay-meta', makeEl());
    byId.set('forecast-replay-time-label', makeEl());
    byId.set('btn-forecast-replay-play', makeEl());
    byId.set('btn-forecast-replay-pause', makeEl());
    byId.set('btn-forecast-replay-reset', makeEl());
    byId.set('forecast-replay-speed', makeEl({ value: '15' }));
    const controls = makeEl();
    byId.set('forecast-replay-controls', controls);
    const root = makeEl();
    root.querySelector = (selector: string) => {
      const idMatch = selector.match(/^#(.+)$/);
      return idMatch ? byId.get(idMatch[1]) || null : null;
    };

    const frames: number[] = [];
    const binding = sandbox.BpwReplayControls.bindReplayControls({
      root,
      idPrefix: 'forecast-replay',
      timestamps,
      timelineMode: 'frame',
      initialFrame: 'end',
      createPlaybackClock: sandbox.BpwPlaybackClock.createPlaybackClock,
      now: () => sandbox.__now,
      requestAnimationFrame: (cb: Function) => {
        sandbox.__raf = cb;
        return 1;
      },
      cancelAnimationFrame: () => { sandbox.__raf = null; },
      onFrame: (position: any) => frames.push(position.sampleIndex),
    });

    expect(byId.get('forecast-replay-meta').textContent).toContain('Frame 3 / 3');
    expect(frames.at(-1)).toBe(2);

    byId.get('forecast-replay-timeline').value = '0';
    byId.get('forecast-replay-timeline').listeners.input();
    expect(byId.get('forecast-replay-meta').textContent).toContain('Frame 1 / 3');
    expect(frames.at(-1)).toBe(0);

    binding.destroy();
  });
});
