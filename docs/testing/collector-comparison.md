# Compare shell and Daemonitor collectors

BPW supports `collector: shell` (the existing default) and `collector: daemonitor` (experimental). Run them in separate jobs against the same workload commit. Running both monitors over one build is useful for collection debugging, but cannot measure each collector's build overhead independently.

## Manual comparison workflow

Once these workflow changes are available on the repository's default branch, run **Compare BPW collectors** (`.github/workflows/collector-comparison.yml`) and select the BPW branch/ref to test. Provide:

- Public workload repository and ref.
- The build command to execute in that checkout, such as `./gradlew assemble --no-daemon`.
- Java version, identical for both jobs.
- Optional remote monitoring and BigQuery export flags.

The workflow resolves the workload ref once and passes that immutable SHA to both jobs. Both use Ubuntu, the same JDK, command, and five-second observation interval. Runner hardware, dependency downloads, and cache state can still vary; repeated runs with controlled cache conditions are needed for performance conclusions.

The Daemonitor job installs `cdsap/tap/daemonitor-cli` with Homebrew and requires version **1.3.3**. The formula installs both `daemonitor-cli` and `daemonitor-cored` and verifies the release archive's checksum. The workflow fails if Homebrew installs a different version; changing the expected version is an explicit workflow edit. No Daemonitor source checkout or Go toolchain is needed.

Each run ID ends in `shell` or `daemonitor`. Artifacts are named `build_process_watcher-compare-<attempt>` for shell and `build_process_watcher-compare-<attempt>-daemonitor` for Daemonitor. JSON report filenames also include the distinct run ID. Compare those exported JSON files using BPW's existing compare/import flow.

With remote monitoring enabled, both variants use the same BPW backend. Configure repository variables `BPW_BACKEND_URL` and `BPW_FRONTEND_URL` for custom endpoints, or leave them unset to use BPW's existing defaults. `export_to_bigquery` requires remote monitoring and a backend with BigQuery export configured.

## Use the new collector in another workflow

Set up Node 24 and your JDK, then install the native executables before starting BPW. Homebrew is preinstalled on GitHub-hosted Ubuntu runners; on other runners, install Homebrew first and put `brew` on `PATH`.

```yaml
- name: Install Daemonitor CLI
  id: daemonitor
  run: |
    eval "$(/home/linuxbrew/.linuxbrew/bin/brew shellenv)" # GitHub-hosted Ubuntu
    brew install cdsap/tap/daemonitor-cli
    test "$(brew list --versions cdsap/tap/daemonitor-cli)" = "daemonitor-cli 1.3.3"
    echo "bin_dir=$(brew --prefix cdsap/tap/daemonitor-cli)/bin" >> "$GITHUB_OUTPUT"

- uses: ./path/to/bpw
  with:
    collector: daemonitor
    daemonitor_bin_dir: ${{ steps.daemonitor.outputs.bin_dir }}
    run_id: comparison-${{ github.run_id }}-${{ github.run_attempt }}-daemonitor
    remote_monitoring: 'true'
    export_to_bigquery: 'true'

- run: ./gradlew assemble --no-daemon
```

Leave `daemonitor_source_commit` unset for Homebrew releases. BPW records the hashes of both installed binaries in the collector artifact. The binaries must be executable on the runner; this BPW integration currently supports Linux and macOS, not Windows.

For unreleased development only, `scripts/build-daemonitor.sh <full-source-commit> <output-bin-dir>` remains available. Set `daemonitor_source_commit` only for those builds: BPW verifies the recorded SHA and both binary hashes against the helper's `build-info.json`.

## Data and completion

Daemonitor owns JVM/OS collection. BPW translates the existing process scope into its current fourteen-column log and the existing `/ingest` requests. Effective numeric/boolean VM flags are fetched from the incarnation-scoped metadata endpoint and written into the existing `process_info` sidecar. Omitted string/path flags remain omitted according to Daemonitor's privacy policy.

BPW writes requests to a local outbox before uploading. Successful acknowledgements advance a durable byte cursor. Freshness diagnostics use one request and a distinct sample ID per process observation, as required by the backend. The delivery cursor records the latest upload error until acknowledgement succeeds. Authentication includes the existing run export/prediction settings; one rejected token is refreshed. Upload failures leave pending requests for retry. Delivery is at least once: an ambiguous network failure after server acceptance can lead to a duplicate retry; this does not introduce a new server-side idempotency contract.

At the Action post-step, BPW requests collector shutdown, drains pending data, and only then uses its existing authenticated finish endpoint. That endpoint stores completion in Firestore and schedules the optional BigQuery export. If delivery remains incomplete or the collector failed, the Daemonitor post-step fails and does not explicitly finish the run. The backend's existing stale-run auto-finish policy still applies; this is not a guarantee of eventual delivery after a runner disappears. Raw capture/outbox artifacts make a partial run inspectable.

The shell path retains its existing behavior. Selecting Daemonitor never silently falls back to shell, so a failed variant cannot masquerade as the control.

## Metric compatibility limits

- Daemonitor's used/committed heap includes survivor spaces. The shell currently uses Eden plus Old generation. An observed difference is not automatically a collector error.
- The legacy numeric-heap ingest contract cannot represent RSS-only samples while a JVM probe is pending/unavailable. Daemonitor records those samples in its raw capture and counts them in `done.json`, but omits them from legacy reports/uploads rather than inventing zero heap. Very short builds or missing-tool environments can therefore have few or no report samples.
- Raw captures retain the native family measurement timestamps; a five-second BPW interval does not mean JVM probes refresh every five seconds. Native cadence is ten seconds for heap/GC and twenty seconds for advanced JVM counters. BPW supplies a bounded five-second JVM-family probe budget instead of the native 750 ms default, allowing sequential JDK commands time to complete during a busy build. Probe failures remain visible in raw diagnostics; missing GC is still represented as zero by the legacy backend parser.
- PID reuse is rejected rather than merging two lifetimes into the current BPW export identity.
- Own-process RSS is used, not subtree totals. Wrapper/Bazel/toolchain expansion is outside this comparison.

Daemonitor artifacts include the collector/source manifest, selected raw metric snapshots, sanitized metadata, outbox, delivery cursor, completion status, and monitor log. Raw metric capture strips command line, working-directory, and project-path fields. Native source timestamps and optional metrics remain available for diagnosis without adding required fields to existing reports.

## Local verification

Build BPW, then run both Action main/post paths against a local test backend:

```bash
npm run build
npm test -- --runInBand
node scripts/verify-collector-comparison.mjs "$(brew --prefix cdsap/tap/daemonitor-cli)/bin"
```

The verification uses real native binaries and simultaneous Gradle/Kotlin HotSpot fixtures with freshness diagnostics enabled, exercises shell and Daemonitor variants, token refresh, metadata delivery, local reports, and finish-after-drain ordering. It also verifies that a simulated upload outage retains the outbox and prevents explicit run completion. It does not contact Firestore or BigQuery. Host process inspection and loopback/socket access are required.

The workflow is supplied for Linux validation; a local macOS pass does not establish that a hosted workflow has run. No workflow dispatch, release, or cloud deployment is part of the local implementation.

## JIT and class activity timing

New collector samples carry optional `metric_measurements` on ingestion and `MetricMeasurements` in stored/exported JSON. This records `jit_sampled_at_ms`, `classes_sampled_at_ms`, and the process start time when available. Daemonitor supplies its acquisition timestamps; shell records completion of each successful `jstat` call. These times are separate from snapshot and upload timing.

Activity rates use counter deltas divided by acquisition-time deltas. Repeated cached acquisitions create no new activity point. A fresh unchanged counter produces zero; unavailable measurements, counter resets and JVM lifetime changes break the rate baseline. Cumulative counters continue to display across cached observations. HotSpot's `jstat -class` `Loaded` is already cumulative; BPW does not add `Unloaded` to it.

The fourteen-column log and CSV remain unchanged. An optional `.measurements.jsonl` sidecar preserves timing for the packed JSON report. Older JSON/CSV without acquisition metadata retains the legacy approximate rate calculation. Older backends accept the new request field but ignore it; accurate dashboard rates require the corresponding backend and frontend changes. The comparison workflow does not deploy either service.

For controlled collector comparisons, use similar JVM probe cadences and compare averages over comparable windows and final counters. A coarse measurement interval cannot recover shorter activity peaks.

## Frontend deployment boundary

Changes whose only frontend file is `frontend/public/compare-shared.js` do not trigger automatic Firebase deployment on merge. Publish these chart updates through the existing manual **Deploy Frontend** workflow after approving the backend/frontend rollout. Normal frontend changes retain automatic deployment; a change that also includes another frontend file can still trigger it. Recheck the frontend file list before merging the collector PR.
