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
    expect(homepage).toContain("prediction_mode: 'predict'");
    expect(homepage).toContain('disabled by default');
    expect(homepage).toContain('implies Remote Mode; BigQuery export must be requested separately');
    expect(homepage).toContain('TabPFN requires an available VM and is disabled by default');
    expect(homepage).toContain('advisory signal for triage');
    expect(homepage).toContain('not a guaranteed OOM, timeout, or build-failure outcome');
    expect(homepage).toContain('Do not use it as a production decision or reliability guarantee');
    expect(homepage).not.toMatch(/training data|service endpoint|threshold/i);
  });

  it('pins README and homepage examples to the same identified development artifact', () => {
    const readme = fs.readFileSync(path.join(__dirname, '../README.md'), 'utf8');
    const refs = (text: string) => [...text.matchAll(/uses: cdsap\/build-process-watcher@([^\s<]+)/g)].map(match => match[1]);
    const homepageRefs = refs(homepage);
    expect(homepageRefs.length).toBeGreaterThan(0);
    expect(homepageRefs[0]).toMatch(/^[a-f0-9]{40}$/);
    expect(new Set(homepageRefs).size).toBe(1);
    // v0.7.0 is allowed only in the historical "Before" migration example.
    expect(new Set(refs(readme).filter(ref => ref !== 'v0.7.0'))).toEqual(new Set(homepageRefs));
    const notes = fs.readFileSync(path.join(__dirname, '../RELEASE_NOTES.md'), 'utf8');
    expect(notes).toContain(`cdsap/build-process-watcher@${homepageRefs[0]}`);
    for (const doc of [readme, homepage]) {
      expect(doc).toContain('v0.8.0');
      expect(doc).toContain('unreleased');
      expect(doc).toContain('development ref');
    }
    const yamlBlocks = [...readme.matchAll(/```yaml\n([\s\S]*?)```/g)].map(match => match[1]);
    const legacyBlocks = yamlBlocks.filter(block => block.includes('@v0.7.0'));
    expect(legacyBlocks).toHaveLength(1);
    expect(legacyBlocks[0]).toContain("predictive_reliability: 'true'");
    expect(legacyBlocks[0]).not.toContain('prediction_mode:');
    expect(yamlBlocks.some(block => block.includes("prediction_mode: 'predict'") && block.includes("export_to_bigquery: 'true'"))).toBe(true);
    expect(readme).toContain('behavior change, not a rename');
    expect(readme).toContain('historical reliability records remain legacy data');
  });

  it('records release readiness separately from publication and deployment', () => {
    const notes = fs.readFileSync(path.join(__dirname, '../RELEASE_NOTES.md'), 'utf8');
    expect(notes).toContain('# v0.8.0 (unreleased)');
    for (const field of ['Source commit', 'Published artifact/ref', 'Documentation', 'Deployment']) {
      expect(notes).toContain(`| ${field} |`);
    }
    expect(notes).toContain('dist/index_with_backend.js');
    expect(notes).toContain('does not authorize publication or deployment');
    expect(notes).toContain('# v0.7.0\n\nReleased 2026-09-30.');
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
