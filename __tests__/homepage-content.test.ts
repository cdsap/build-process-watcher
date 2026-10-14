import * as fs from 'fs';
import * as path from 'path';

const homepage = fs.readFileSync(
  path.join(__dirname, '../frontend/public/index.html'),
  'utf8',
);

describe('public homepage content', () => {
  it('explains the collection modes, outputs, and analysis workflows', () => {
    expect(homepage).toContain('id="whats-new"');
    expect(homepage).toContain('What is new');
    expect(homepage).toContain('Local Mode · artifacts only');
    expect(homepage).toContain('Remote Mode · live dashboard');
    expect(homepage).toContain('BigQuery export · optional');
    expect(homepage).toContain('retains the hosted report for 24 hours');
    expect(homepage).toContain('id="analysis-tools"');
    expect(homepage).toContain('id="analysis-replay-link"');
    expect(homepage).toContain('id="analysis-compare-link"');
  });

  it('labels prediction as experimental and states its limits', () => {
    expect(homepage).toContain('id="prediction"');
    expect(homepage).toContain('Experimental');
    expect(homepage).toContain("predictive_reliability: 'true'");
    expect(homepage).toContain('disabled by default');
    expect(homepage).toContain('implies Remote Mode and requests BigQuery export');
    expect(homepage).toContain('advisory signal for triage');
    expect(homepage).toContain('not a guaranteed OOM, timeout, or build-failure outcome');
    expect(homepage).toContain('Do not use it as a production decision or reliability guarantee');
    expect(homepage).not.toMatch(/training data|service endpoint|threshold/i);
  });

  it('keeps homepage navigation and documentation links wired', () => {
    expect(homepage).toContain('id="nav-demo-link"');
    expect(homepage).toContain('id="nav-replay-link"');
    expect(homepage).toContain('id="nav-compare-link"');
    expect(homepage).toContain('https://github.com/cdsap/build-process-watcher');
    expect(homepage).toContain('https://github.com/cdsap/build-process-watcher#inputs');
    expect(homepage).toContain("setHref('#nav-replay-link, #replay-link, #analysis-replay-link', '/replay.html')");
    expect(homepage).toContain("setHref('#nav-compare-link, #compare-link, #analysis-compare-link', '/compare.html')");
  });
});
