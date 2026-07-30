import * as fs from 'fs';
import * as path from 'path';

const publicDir = path.join(__dirname, '../frontend/public');
const repoRoot = path.join(__dirname, '..');

const publicPages = [
  { file: 'index.html', canonical: 'https://process-watcher.web.app/' },
  { file: 'compare.html', canonical: 'https://process-watcher.web.app/compare.html', noindex: true },
  { file: 'replay.html', canonical: 'https://process-watcher.web.app/replay.html', noindex: true },
  { file: 'runs/demo.html', canonical: 'https://process-watcher.web.app/runs/demo.html' },
];

function readPage(file: string): string {
  return fs.readFileSync(path.join(publicDir, file), 'utf8');
}

function metaContent(html: string, attribute: 'name' | 'property', value: string): string | undefined {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return html.match(new RegExp(`<meta\\s+${attribute}=["']${escaped}["']\\s+content=["']([^"']+)["']`, 'i'))?.[1];
}

describe('frontend discovery and social metadata', () => {
  it('keeps predictive reliability disabled in the public config', () => {
    expect(readPage('config.js')).toContain('predictiveReliability: false');
  });

  it('documents predictive reliability as an opt-in action input', () => {
    const action = fs.readFileSync(path.join(repoRoot, 'action.yaml'), 'utf8');
    expect(action).toContain('predictive_reliability:');
    expect(action).toContain("default: 'false'");
    expect(readPage('index.html')).toContain('<code>predictive_reliability</code>');
  });

  it.each(publicPages)('$file has complete page-specific sharing metadata', ({ file, canonical, noindex }) => {
    const html = readPage(file);
    const description = metaContent(html, 'name', 'description');
    const canonicalUrl = html.match(/<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/i)?.[1];

    expect(description).toBeTruthy();
    expect(canonicalUrl).toBe(canonical);
    expect(metaContent(html, 'property', 'og:title')).toBeTruthy();
    expect(metaContent(html, 'property', 'og:description')).toBe(description);
    expect(metaContent(html, 'property', 'og:url')).toBe(canonical);
    expect(metaContent(html, 'property', 'og:type')).toBe('website');
    expect(metaContent(html, 'name', 'twitter:card')).toBe('summary_large_image');
    expect(metaContent(html, 'name', 'twitter:title')).toBeTruthy();
    expect(metaContent(html, 'name', 'twitter:description')).toBe(description);

    const openGraphImage = metaContent(html, 'property', 'og:image');
    for (const url of [canonicalUrl, metaContent(html, 'property', 'og:url'), openGraphImage, metaContent(html, 'name', 'twitter:image')]) {
      expect(url).toMatch(/^https:\/\//);
    }
    expect(fs.existsSync(path.join(publicDir, new URL(openGraphImage!).pathname))).toBe(true);

    if (noindex) expect(metaContent(html, 'name', 'robots')).toMatch(/\bnoindex\b/);
  });

  it('uses unique descriptions and titles for public pages', () => {
    const pages = publicPages.map(({ file }) => readPage(file));
    const descriptions = pages.map(html => metaContent(html, 'name', 'description'));
    const titles = pages.map(html => metaContent(html, 'property', 'og:title'));

    expect(new Set(descriptions).size).toBe(publicPages.length);
    expect(new Set(titles).size).toBe(publicPages.length);
  });

  it.each(['runs/[runId].html', 'runs/index.html'])('%s prevents indexing of ephemeral run routes', file => {
    expect(metaContent(readPage(file), 'name', 'robots')).toMatch(/\bnoindex\b/);
  });
});
