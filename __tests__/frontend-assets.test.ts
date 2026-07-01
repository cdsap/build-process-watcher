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
