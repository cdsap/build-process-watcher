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

  it('accepts extra timeline chrome and play aria-pressed', () => {
    const sandbox = loadReplayStack();
    const html = sandbox.BpwReplayControls.renderReplayControls({
      idPrefix: 'rss-replay',
      playAriaPressed: false,
      extraTimelineHtml: '<div class="meta" id="rss-replay-viewport-wrap">Viewport</div>',
    });
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('id="rss-replay-viewport-wrap"');
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

  it('skips duplicate onFrame renders on unchanged sampleIndex in frame mode and applies speed changes', () => {
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

    const timestamps = [0, 10_000, 20_000, 30_000];
    byId.set('compare-replay-timeline', makeEl({ value: '0' }));
    byId.set('compare-replay-meta', makeEl());
    byId.set('compare-replay-time-label', makeEl());
    byId.set('btn-compare-replay-play', makeEl());
    byId.set('btn-compare-replay-pause', makeEl());
    byId.set('btn-compare-replay-reset', makeEl());
    byId.set('compare-replay-speed', makeEl({ value: '5' }));
    byId.set('compare-replay-controls', makeEl());
    const root = makeEl();
    root.querySelector = (selector: string) => {
      const idMatch = selector.match(/^#(.+)$/);
      return idMatch ? byId.get(idMatch[1]) || null : null;
    };

    const onFrame = jest.fn();
    const binding = sandbox.BpwReplayControls.bindReplayControls({
      root,
      idPrefix: 'compare-replay',
      timestamps,
      timelineMode: 'frame',
      initialFrame: 0,
      createPlaybackClock: sandbox.BpwPlaybackClock.createPlaybackClock,
      now: () => sandbox.__now,
      requestAnimationFrame: (cb: Function) => {
        sandbox.__raf = cb;
        return 1;
      },
      cancelAnimationFrame: () => { sandbox.__raf = null; },
      onFrame,
    });

    expect(onFrame).toHaveBeenCalledTimes(1);
    byId.get('btn-compare-replay-play').listeners.click();
    const callsAfterPlay = onFrame.mock.calls.length;

    // Multiple rAF ticks inside frame 0 should not re-trigger onFrame.
    sandbox.__now = 200; // 1_000ms logical
    sandbox.__raf(sandbox.__now);
    sandbox.__now = 400; // 2_000ms logical
    sandbox.__raf(sandbox.__now);
    expect(onFrame).toHaveBeenCalledTimes(callsAfterPlay);

    // Switch speed to 50x mid-play and advance 200ms wall => +10_000ms logical (frame 1).
    byId.get('compare-replay-speed').value = '50';
    byId.get('compare-replay-speed').listeners.change();
    sandbox.__now = 600;
    sandbox.__raf(sandbox.__now);
    expect(onFrame).toHaveBeenCalledTimes(callsAfterPlay + 1);
    expect(onFrame.mock.calls[onFrame.mock.calls.length - 1][0].sampleIndex).toBe(1);

    binding.destroy();
  });
});
