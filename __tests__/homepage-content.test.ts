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
    expect(homepage).toContain('automatically enable Remote Mode');
    expect(homepage).toContain('does not enable <code>export_to_bigquery</code>');
    expect(homepage).toContain('advisory signal for triage');
    expect(homepage).toContain('not a guaranteed OOM, timeout, or build-failure outcome');
    expect(homepage).toContain('Do not use it as a production decision or reliability guarantee');
    expect(homepage).not.toMatch(/training data|service endpoint|threshold/i);
  });

  it('keeps mode choices, defaults, and availability consistent with the guide', () => {
    const readme = fs.readFileSync(path.join(__dirname, '../README.md'), 'utf8');
    const guide = fs.readFileSync(path.join(__dirname, '../docs/prediction.md'), 'utf8');
    const rows = [...homepage.matchAll(/<tr>[\s\S]*?<\/tr>/g)].map(match => match[0]);
    for (const [mode, model] of [
      ['disabled', 'No prediction request'],
      ['forecast', 'TimesFM'],
      ['predict', 'TabFM'],
      ['bqml-boosted', 'BigQuery ML boosted'],
      ['tabpfn', 'TabPFN GPU'],
    ]) {
      expect(rows.find(row => row.includes(`<td><code>${mode}</code>`))).toContain(model);
      for (const doc of [readme, guide]) {
        expect(doc).toMatch(new RegExp('`' + mode + '`[^\\n]*' + model));
      }
    }
    expect(rows.find(row => row.includes('<td><code>prediction_mode</code></td>'))).toContain('<td><code>disabled</code></td>');
    const cadenceRow = rows.find(row => row.includes('<td><code>prediction_throttle_s</code></td>'));
    expect(cadenceRow).toContain('1–3600');
    expect(cadenceRow).toContain('<td><code>20</code></td>');
    for (const doc of [homepage, readme, guide]) {
      expect(doc).toContain('TabPFN is disabled by default');
      expect(doc).toContain('Selecting the input does not start the VM');
    }
    expect(homepage).not.toContain('requests BigQuery export');
  });

  it('provides valid workflow snippets and resolvable prediction documentation links', () => {
    const yaml = require('js-yaml');
    const manifest = yaml.load(fs.readFileSync(path.join(__dirname, '../action.yaml'), 'utf8'));
    for (const match of homepage.matchAll(/<pre[^>]*><code>([\s\S]*?)<\/code><\/pre>/g)) {
      const steps = yaml.load(match[1]);
      expect(Array.isArray(steps)).toBe(true);
      for (const step of steps.filter((step: { uses?: string }) => step.uses)) {
        for (const input of Object.keys(step.with || {})) {
          expect(manifest.inputs).toHaveProperty(input);
        }
      }
    }
    const ids = [...homepage.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const match of homepage.matchAll(/href="#([^"]+)"/g)) {
      expect(ids).toContain(match[1]);
    }
    const prefix = 'https://github.com/cdsap/build-process-watcher/blob/main/';
    for (const match of homepage.matchAll(/href="([^"]+)"/g)) {
      if (!match[1].startsWith(prefix)) continue;
      const [file, anchor] = match[1].slice(prefix.length).split('#');
      const doc = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
      if (anchor) {
        const headings = [...doc.matchAll(/^#+ (.+)$/gm)].map(heading => heading[1].toLowerCase().replace(/ /g, '-'));
        expect(headings).toContain(anchor);
      }
    }
  });

  it('pins every example to the documented development artifact rather than the old release', () => {
    const readme = fs.readFileSync(path.join(__dirname, '../README.md'), 'utf8');
    const releaseNotes = fs.readFileSync(path.join(__dirname, '../RELEASE_NOTES.md'), 'utf8');
    const ref = '88f0d0b85857dd71009cf827564fb33d75769214';
    for (const doc of [homepage, readme]) {
      const refs = [...doc.matchAll(/uses: cdsap\/build-process-watcher@([^\s<]+)/g)].map(match => match[1]);
      expect(refs.length).toBeGreaterThanOrEqual(4);
      expect(refs.every(value => value === ref)).toBe(true);
      expect(doc).toContain('Unreleased development ref');
    }
    expect(homepage).toContain('Snippets: development ref 88f0d0b');
    expect(releaseNotes).toContain(ref);
    expect(homepage).toContain('RELEASE_NOTES.md#migration');
    expect(homepage).toContain('docs/prediction.md');
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
