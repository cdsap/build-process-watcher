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
  it('includes every local script referenced by an HTML page', () => {
    const missing: string[] = [];

    for (const htmlFile of htmlFiles(publicDir)) {
      const html = fs.readFileSync(htmlFile, 'utf8');
      for (const match of html.matchAll(/<script\s[^>]*src=["']([^"']+)["']/g)) {
        const source = match[1];
        if (/^https?:\/\//.test(source)) continue;

        const assetPath = source.startsWith('/')
          ? path.join(publicDir, source.slice(1))
          : path.resolve(path.dirname(htmlFile), source);
        if (!fs.existsSync(assetPath)) {
          missing.push(`${path.relative(publicDir, htmlFile)}: ${source}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
