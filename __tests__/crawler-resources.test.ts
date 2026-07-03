import * as fs from 'fs';
import * as path from 'path';

const repositoryRoot = path.resolve(__dirname, '..');
const publicDirectory = path.join(repositoryRoot, 'frontend', 'public');

describe('crawler resources', () => {
  it('serves crawler directives that reference the production sitemap', () => {
    const robots = fs.readFileSync(path.join(publicDirectory, 'robots.txt'), 'utf8');

    expect(robots).toContain('User-agent: *');
    expect(robots).toContain('Disallow: /runs/');
    expect(robots).toContain('Disallow: /replay.html');
    expect(robots).toContain('Disallow: /compare.html');
    expect(robots).toContain('Sitemap: https://process-watcher.web.app/sitemap.xml');
  });

  it('lists only the canonical public homepage in the sitemap', () => {
    const sitemap = fs.readFileSync(path.join(publicDirectory, 'sitemap.xml'), 'utf8');
    const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);

    expect(sitemap).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    expect(sitemap).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(locations).toEqual(['https://process-watcher.web.app/']);
  });

  it('configures explicit content types for both crawler resources', () => {
    const firebaseConfig = JSON.parse(
      fs.readFileSync(path.join(repositoryRoot, 'frontend', 'firebase.json'), 'utf8')
    );
    const headers = firebaseConfig.hosting.headers;

    expect(headers).toEqual(
      expect.arrayContaining([
        {
          source: '/robots.txt',
          headers: [{ key: 'Content-Type', value: 'text/plain; charset=utf-8' }],
        },
        {
          source: '/sitemap.xml',
          headers: [{ key: 'Content-Type', value: 'application/xml; charset=utf-8' }],
        },
      ])
    );
  });
});
