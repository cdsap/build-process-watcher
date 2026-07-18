# Agent Instructions

## Project Overview

Build Process Watcher is a GitHub Action and static dashboard for monitoring Java/Kotlin build processes such as `GradleDaemon`, `GradleWorkerMain`, and `KotlinCompileDaemon`.

The project collects heap, RSS, GC, JIT compilation, class loading, process metadata, and VM flags. The frontend supports live run dashboards, replay, and compare flows.

## Repository Shape

- `src/`: TypeScript GitHub Action and report generation code.
- `backend/`: Go backend built with Bazel; keep `BUILD.bazel` files and `MODULE.bazel` in sync with package or dependency changes.
- `frontend/public/`: static dashboard, replay, compare, and experiment UI assets.
- `__tests__/`: Jest tests for reports, metrics, and shared frontend logic.
- `scripts/`: helper scripts.
- `dist/`: built action bundle.

## Commands

Run these before committing relevant changes:

```bash
npm test -- --runInBand
```

For JavaScript files in `frontend/public/`, also run syntax checks on changed files:

```bash
node --check frontend/public/<file>.js
```

For action bundle changes:

```bash
npm run build
```

For backend changes, run Bazel commands from the backend module:

```bash
cd backend && bazel test //...
```

For backend build-path changes, also verify the server target:

```bash
cd backend && bazel build //:server
```

For backend coverage changes:

```bash
cd backend && bazel coverage //... --combined_report=lcov
```

When adding or moving Go packages under `backend/`, update the relevant `backend/BUILD.bazel` files and `backend/MODULE.bazel` rather than falling back to direct `go build` or `go test` commands.

## Frontend Guidance

- Preserve the existing static HTML/CSS/JS architecture. Do not introduce a framework unless explicitly requested.
- Keep compare, replay, and run-dashboard behavior compatible with uploaded/exported JSON from older runs.
- Prefer small, focused CSS additions in `frontend/public/bpw-ui.css` or the page-specific stylesheet already in use.
- The compare page should remain classic-only unless the user explicitly asks to reintroduce experiment/studio controls.
- Keep mobile layouts readable. Use stable grid dimensions and horizontal scrolling for dense metric comparisons when needed.
- Avoid explanatory product copy in tool surfaces; labels should be operational and scannable.

## Data Compatibility

- Treat missing metrics as valid legacy data. JIT, class loading, GC, and process summaries may be absent or partially populated.
- Do not require new artifact fields when information can be derived from existing samples or `process_info.vm_flags`.
- Preserve existing export/import shapes unless the user explicitly asks for a schema change.

## Git Hygiene

- The worktree may contain user changes. Do not revert or delete files you did not create.
- Stage only files related to the current task.
- Leave untracked planning or documentation files alone unless the user asks to edit them.

## Current Notes

- `DATABASE.md`, `EXPERIMENT_UI.md`, `requirements.md`, and some backend schema files may appear as untracked local work. Treat them as user-owned unless explicitly instructed otherwise.
