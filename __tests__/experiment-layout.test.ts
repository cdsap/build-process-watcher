import fs from 'fs';
import path from 'path';
import vm from 'vm';

function makeElement(value = ''): any {
  const listeners = new Map<string, Function>();
  return {
    dataset: {},
    hidden: false,
    max: '0',
    textContent: '',
    value,
    addEventListener: (type: string, listener: Function) => listeners.set(type, listener),
    dispatch: (type: string) => listeners.get(type)?.({ target: null }),
  };
}

function loadExperimentLayout() {
  const elements = new Map<string, any>([
    ['bpw-unified-replay', makeElement()],
    ['btn-bpw-unified-play', makeElement()],
    ['btn-bpw-unified-pause', makeElement()],
    ['btn-bpw-unified-reset', makeElement()],
    ['bpw-unified-timeline', makeElement('0')],
    ['bpw-unified-speed', makeElement('15')],
    ['bpw-unified-meta', makeElement()],
    ['bpw-unified-time-label', makeElement()],
  ]);
  const storage = new Map([['bpwLayoutMode', 'experiment']]);
  const sandbox: any = {
    __now: 0,
    __raf: null,
    cancelAnimationFrame: jest.fn(() => { sandbox.__raf = null; }),
    clearTimeout: jest.fn(),
    console,
    document: {
      addEventListener: jest.fn(),
      getElementById: (id: string) => elements.get(id) || null,
      querySelectorAll: () => [],
      readyState: 'loading',
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) || null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    matchMedia: () => ({ matches: false }),
    performance: { now: () => sandbox.__now },
    requestAnimationFrame: jest.fn((callback: Function) => {
      sandbox.__raf = callback;
      return 1;
    }),
    setTimeout: jest.fn(),
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;

  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../frontend/public/playback-clock.js'), 'utf8'),
    sandbox,
  );
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../frontend/public/experiment-layout.js'), 'utf8'),
    sandbox,
  );

  return { elements, layout: sandbox.BpwExperimentLayout, sandbox };
}

describe('experiment unified replay', () => {
  it('uses the playback clock for play, pause, scrub, and speed changes', async () => {
    const { elements, layout, sandbox } = loadExperimentLayout();
    const panel = {
      getMaxFrame: () => 2,
      pause: jest.fn(),
      renderFrame: jest.fn(() => Promise.resolve()),
    };
    layout.registerReplayPanel(panel);
    layout.initUnifiedReplay({
      timestamps: [1_000, 2_000, 3_000],
      elapsedByTimestamp: new Map([[1_000, 0], [2_000, 1], [3_000, 2]]),
    });
    await Promise.resolve();

    expect(panel.renderFrame).toHaveBeenLastCalledWith(2);

    const rendersBeforeRefresh = panel.renderFrame.mock.calls.length;
    layout.initUnifiedReplay({
      timestamps: [1_000, 2_000, 3_000],
      elapsedByTimestamp: new Map([[1_000, 0], [2_000, 1], [3_000, 2]]),
    });
    await Promise.resolve();
    expect(panel.renderFrame).toHaveBeenCalledTimes(rendersBeforeRefresh + 1);
    expect(panel.renderFrame).toHaveBeenLastCalledWith(2);

    elements.get('btn-bpw-unified-reset').dispatch('click');
    elements.get('btn-bpw-unified-play').dispatch('click');
    sandbox.__now = 100;
    sandbox.__raf(sandbox.__now);
    await Promise.resolve();

    expect(panel.renderFrame).toHaveBeenLastCalledWith(1);
    expect(sandbox.setTimeout).not.toHaveBeenCalled();

    elements.get('btn-bpw-unified-pause').dispatch('click');
    expect(sandbox.cancelAnimationFrame).toHaveBeenCalled();

    elements.get('bpw-unified-speed').value = '5';
    elements.get('bpw-unified-speed').dispatch('change');
    elements.get('btn-bpw-unified-reset').dispatch('click');
    elements.get('btn-bpw-unified-play').dispatch('click');
    sandbox.__now = 300;
    sandbox.__raf(sandbox.__now);
    await Promise.resolve();
    expect(panel.renderFrame).toHaveBeenLastCalledWith(1);

    elements.get('bpw-unified-timeline').value = '2';
    elements.get('bpw-unified-timeline').dispatch('input');
    await Promise.resolve();
    expect(panel.renderFrame).toHaveBeenLastCalledWith(2);
  });
});
