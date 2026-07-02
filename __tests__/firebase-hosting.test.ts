import * as fs from 'fs';
import * as path from 'path';

type Rewrite = {
  source: string;
  destination: string;
};

type FirebaseConfig = {
  hosting: {
    rewrites?: Rewrite[];
  };
};

const frontendDir = path.join(__dirname, '../frontend');
const publicDir = path.join(frontendDir, 'public');
const config = JSON.parse(
  fs.readFileSync(path.join(frontendDir, 'firebase.json'), 'utf8'),
) as FirebaseConfig;

function responseFor(requestPath: string): { status: number; file: string } {
  const relativePath = requestPath.replace(/^\/+/, '');
  const requestedFile = path.join(publicDir, relativePath);

  if (fs.existsSync(requestedFile) && fs.statSync(requestedFile).isFile()) {
    return { status: 200, file: requestedFile };
  }

  const runRewrite = config.hosting.rewrites?.find(
    rewrite => rewrite.source === '/runs/**' && requestPath.startsWith('/runs/'),
  );
  if (runRewrite) {
    return { status: 200, file: path.join(publicDir, runRewrite.destination.slice(1)) };
  }

  return { status: 404, file: path.join(publicDir, '404.html') };
}

describe('Firebase Hosting routes', () => {
  it('returns the noindex not-found page for an unknown URL', () => {
    const response = responseFor('/missing-seo-check-404');
    const html = fs.readFileSync(response.file, 'utf8');

    expect(response.status).toBe(404);
    expect(html).toMatch(/<h1>Page not found<\/h1>/);
    expect(html).toMatch(/<meta\s+name="robots"\s+content="noindex, nofollow">/);
    expect(html).not.toMatch(/<link\s+rel="canonical"/i);
  });

  it('keeps dynamic run URLs mapped to the run dashboard', () => {
    const response = responseFor('/runs/example-run-id');

    expect(response.status).toBe(200);
    expect(path.relative(publicDir, response.file)).toBe('runs/[runId].html');
    expect(fs.existsSync(response.file)).toBe(true);
  });

  it('does not rewrite arbitrary URLs to the homepage', () => {
    expect(config.hosting.rewrites).not.toContainEqual({
      source: '**',
      destination: '/index.html',
    });
  });
});
