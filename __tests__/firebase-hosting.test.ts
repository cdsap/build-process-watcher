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

describe('frontend deployment boundary', () => {
  const yaml = require('js-yaml');
  const micromatch = require('micromatch');
  const workflow = yaml.load(fs.readFileSync(path.join(__dirname, '../.github/workflows/deploy-frontend.yml'), 'utf8'));
  const autoDeploys = (branch: string, files: string[]) => {
    const push = workflow.on.push;
    return !!push && micromatch.isMatch(branch, push.branches) && micromatch(files, push.paths).length > 0;
  };

  it('does not auto-deploy shared chart changes accompanied only by non-frontend files', () => {
    expect(autoDeploys('main', ['frontend/public/compare-shared.js', 'backend/internal/models/models.go',
      'src/lib/report.ts', '.github/workflows/deploy-frontend.yml'])).toBe(false);
  });
  it('keeps normal public frontend changes eligible for automatic deployment', () => {
    expect(autoDeploys('main', ['frontend/public/index.html'])).toBe(true);
    expect(autoDeploys('main', ['frontend/public/compare-shared.js', 'frontend/public/bpw-ui.css'])).toBe(true);
  });
  it('never auto-deploys a feature branch', () => {
    expect(autoDeploys('feat/daemonitor-collector-comparison', ['frontend/public/index.html'])).toBe(false);
  });
  it('retains the explicit manual deployment entry point for main', () => {
    expect(workflow.on.workflow_dispatch.inputs.branch.options).toContain('main');
  });
});
