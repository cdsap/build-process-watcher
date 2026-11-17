import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

function loadView(): any {
  const window: any = {};
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../frontend/public/freshness-view.js'), 'utf8'),
    { window },
  );
  return window.BpwFreshnessView;
}

describe('freshness diagnostics view model', () => {
  const view = loadView();
  const samples = [
    {
      PID: '1',
      Name: 'GradleDaemon',
      Freshness: {
        sample_id: '1-1', sequence: 1,
        collected_at_unix_ms: 1000,
        backend_received_at_unix_ms: 1100,
        backend_stored_at_unix_ms: 1140,
        backend_storage_duration_ms: 40,
      },
    },
    {
      PID: '1',
      Name: 'GradleDaemon',
      Freshness: {
        sample_id: '3-1', sequence: 3,
        collected_at_unix_ms: 2000,
        backend_received_at_unix_ms: 2150,
        backend_stored_at_unix_ms: 2200,
        backend_storage_duration_ms: 50,
      },
    },
  ];

  it('summarizes percentiles, sequence gaps, and end-to-end age', () => {
    expect(view.summarize(samples, 2500, 75)).toEqual({
      sampleCount: 2,
      sequenceGaps: 1,
      clockSkewDetected: false,
      collectionToReceipt: { p50: 100, p95: 150 },
      backendStorage: { p50: 40, p95: 50 },
      storageToRender: { p50: 300, p95: 1360 },
      endToEnd: { p50: 500, p95: 1500 },
      browserFetchRenderMs: 75,
    });
  });

  it('detects cross-host clock skew and ignores legacy samples', () => {
    const skewed = [{ Freshness: {
      sample_id: '1-1', sequence: 1,
      collected_at_unix_ms: 2000,
      backend_received_at_unix_ms: 1000,
      backend_stored_at_unix_ms: 1100,
      backend_storage_duration_ms: 100,
    } }];
    expect(view.summarize(skewed, 1500, 20).clockSkewDetected).toBe(true);
    expect(view.summarize([{ PID: 'legacy' }], 1500, 20)).toBeNull();
  });

  it('renders collapsed header info only for instrumented samples', () => {
    const first = view.render(samples, 2500, 75);
    const html = first.html;
    expect(html).toContain('<details class="freshness-info">');
    expect(html).not.toContain(' open>');
    expect(html).toContain('Freshness');
    expect(html).toContain('Clocks ok');
    expect(html).toContain('Spike telemetry');
    expect(html).toContain('End-to-end p95');
    expect(html).toContain('1 sequence gap');
    expect(view.render(samples, 5000, 80, { open: true }).html).toContain('<details class="freshness-info" open>');
    expect(view.render(samples, 5000, 80).summary.endToEnd).toEqual(first.summary.endToEnd);
    expect(view.render([], 2500, 75)).toBeNull();
  });

  it('updates an open Freshness panel without remounting the details element', () => {
    document.body.innerHTML = '<div id="freshness-diagnostics"></div>';
    const target = document.getElementById('freshness-diagnostics') as HTMLElement;
    const first = view.update(target, samples, 2500, 75);
    expect(first).not.toBeNull();
    const details = target.querySelector('details.freshness-info') as HTMLDetailsElement;
    expect(details).not.toBeNull();
    details.open = true;
    const second = view.update(target, samples, 5000, 80);
    expect(second).not.toBeNull();
    expect(target.querySelector('details.freshness-info')).toBe(details);
    expect(details.open).toBe(true);
    expect(details.querySelector('[data-freshness-metric="browserFetchRenderMs"]')?.textContent).toContain('80');
  });
});
