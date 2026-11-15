import * as fs from 'fs';
import * as path from 'path';

const publicDir = path.join(__dirname, '../frontend/public');

function htmlFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return htmlFiles(entryPath);
    return entry.name.endsWith('.html') ? [entryPath] : [];
  });
}

describe('frontend script assets', () => {
  it('serves JavaScript for every local script referenced by an HTML page', () => {
    const invalid: string[] = [];

    for (const htmlFile of htmlFiles(publicDir)) {
      const html = fs.readFileSync(htmlFile, 'utf8');
      for (const match of html.matchAll(/<script\s[^>]*src=["']([^"']+)["']/g)) {
        const source = match[1];
        if (/^https?:\/\//.test(source)) continue;

        const assetPath = source.startsWith('/')
          ? path.join(publicDir, source.slice(1))
          : path.resolve(path.dirname(htmlFile), source);
        const reference = `${path.relative(publicDir, htmlFile)}: ${source}`;
        if (!fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) {
          invalid.push(`${reference} (missing)`);
          continue;
        }

        const contents = fs.readFileSync(assetPath, 'utf8').trimStart();
        if (/^(?:<!doctype\s+html|<html\b)/i.test(contents)) {
          invalid.push(`${reference} (contains HTML)`);
        }
      }
    }

    expect(invalid).toEqual([]);
  });
});

describe('shared UI chrome CSS', () => {
  const chromePages = [
    'runs/[runId].html',
    'runs/demo.html',
    'compare.html',
    'replay.html',
  ];

  const requiredSelectors = [
    '.run-header-bar',
    '.run-header-main',
    '.status-grid',
    '.replay-controls',
    '.replay-controls .buttons',
    '.replay-controls .timeline',
    '.compare-controls',
    '.upload-controls',
    '.compare-replay-controls',
    '.chart-wrapper',
    '.compare-section',
    '.replay-section',
  ];

  it('keeps shared chrome selectors centralized in bpw-ui.css', () => {
    const css = fs.readFileSync(path.join(publicDir, 'bpw-ui.css'), 'utf8');
    const missing = requiredSelectors.filter(selector => !css.includes(selector));
    expect(missing).toEqual([]);
  });

  it('does not redeclare shared chrome in page inline styles', () => {
    const banned = [
      '.run-header-bar',
      '.replay-controls',
      '.status-grid',
      '.compare-controls',
      '.upload-controls',
      '.chart-wrapper',
    ];
    const offenders: string[] = [];

    for (const relative of chromePages) {
      const html = fs.readFileSync(path.join(publicDir, relative), 'utf8');
      expect(html).toMatch(/href=["']\/bpw-ui\.css["']/);
      const styleBlocks = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]);
      for (const block of styleBlocks) {
        for (const selector of banned) {
          if (block.includes(selector)) {
            offenders.push(`${relative}: ${selector}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
