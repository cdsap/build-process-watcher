import * as fs from 'fs';
import * as path from 'path';

const repositoryRoot = path.join(__dirname, '..');
const read = (relativePath: string): string =>
  fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');

describe('backend Bazel build integration', () => {
  it('defines Bazel targets for the server and all Go tests', () => {
    const moduleFile = read('backend/MODULE.bazel');
    const buildFiles = [
      'backend/BUILD.bazel',
      'backend/internal/auth/BUILD.bazel',
      'backend/internal/bigqueryexport/BUILD.bazel',
      'backend/internal/cleanup/BUILD.bazel',
      'backend/internal/exportqueue/BUILD.bazel',
      'backend/internal/handlers/BUILD.bazel',
      'backend/internal/models/BUILD.bazel',
      'backend/internal/storage/BUILD.bazel',
      'backend/pkg/predictor/BUILD.bazel',
      'backend/pkg/server/BUILD.bazel',
    ].map(read);

    expect(moduleFile).toContain('go_deps.from_file(go_mod = "//:go.mod")');
    expect(moduleFile).toContain('go_sdk.download(version = "1.24.12")');
    expect(moduleFile).not.toContain('go_sdk.from_file');
    expect(read('backend/.bazelversion').trim()).toBe('latest');
    expect(buildFiles.join('\n')).toContain('name = "server"');
    expect(buildFiles.join('\n')).toContain('importpath = "github.com/cdsap/build-process-watcher/backend/pkg/server"');
    expect(buildFiles.filter((contents) => contents.includes('go_test('))).toHaveLength(8);
  });

  it('uses Bazel in local, container, and CI build paths', () => {
    const makefile = read('backend/Makefile');
    const dockerfile = read('backend/Dockerfile');

    expect(makefile).toContain('bazel build //:server');
    expect(makefile).toContain('@rules_go//go/config:race');
    expect(makefile).not.toMatch(/\bgo (?:build|test)\b/);
    expect(dockerfile).toContain('RUN bazel build //:server');
    expect(dockerfile).not.toMatch(/\bgo build\b/);
    expect(read('.github/workflows/test-backend.yml')).toContain(
      'uses: bazel-contrib/setup-bazel@',
    );
    expect(read('.github/workflows/deploy-backend.yml')).toContain(
      'uses: bazel-contrib/setup-bazel@',
    );
  });

  it('documents the backend Bazel workflow in the agent instructions', () => {
    const agentInstructions = read('AGENTS.md');

    expect(agentInstructions).toContain('backend/`: Go backend built with Bazel');
    expect(agentInstructions).toContain('cd backend && bazel test //...');
    expect(agentInstructions).toContain('cd backend && bazel build //:server');
    expect(agentInstructions).toContain('cd backend && bazel coverage //... --combined_report=lcov');
    expect(agentInstructions).toContain('backend/BUILD.bazel');
    expect(agentInstructions).toContain('backend/MODULE.bazel');
  });
});
