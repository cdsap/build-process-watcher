import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

function loadController(): any {
  const sandbox: any = { module: { exports: {} }, exports: {}, performance: { now: () => 1 } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../frontend/public/live-run-controller.js'), 'utf8'),
    sandbox,
  );
  return sandbox.BpwLiveRunController || sandbox.module.exports;
}

describe('live run controller', () => {
  const api = loadController();

  it('rejects overlapping in-flight refreshes and ignores stale responses', async () => {
    const payloads: any[] = [];
    let resolveFirst: Function = () => {};
    const firstPromise = new Promise((resolve) => { resolveFirst = resolve; });
    let calls = 0;
    const controller = api.createLiveRunController({
      fetch: async () => {
        calls += 1;
        if (calls === 1) {
          await firstPromise;
          return {
            ok: true,
            json: async () => ({ finished: false, samples: [{ Timestamp: 1 }] }),
          };
        }
        return {
          ok: true,
          json: async () => ({ finished: false, samples: [{ Timestamp: 2 }] }),
        };
      },
      onData: (event: any) => payloads.push(event.data.samples[0].Timestamp),
    });

    const first = controller.refresh('run-a', 'https://example.test');
    const skipped = await controller.refresh('run-a', 'https://example.test');
    expect(skipped).toEqual({ skipped: true, reason: 'in-flight' });
    resolveFirst();
    await first;
    expect(payloads).toEqual([1]);
    await controller.refresh('run-a', 'https://example.test');
    expect(payloads).toEqual([1, 2]);
  });
});
