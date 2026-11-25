# Compare shell and Daemonitor collectors

BPW supports `collector: shell` (the existing default) and `collector: daemonitor` (experimental). Run them in separate jobs against the same workload commit. Running both monitors over one build is useful for collection debugging, but cannot measure each collector's build overhead independently.

## Manual comparison workflow

Once these workflow changes are available on the repository's default branch, run **Compare BPW collectors** (`.github/workflows/collector-comparison.yml`) and select the BPW branch/ref to test. Provide:

- Public workload repository and ref.
- The build command to execute in that checkout, such as `./gradlew assemble --no-daemon`.
- Java version, identical for both jobs.
- Optional remote monitoring and BigQuery export flags.

The workflow resolves the workload ref once and passes that immutable SHA to both jobs. Both use Ubuntu, the same JDK, command, and five-second observation interval. Runner hardware, dependency downloads, and cache state can still vary; repeated runs with controlled cache conditions are needed for performance conclusions.

The Daemonitor job builds commit `d47b3901277ae0f3d858286c1e884ec35aa0d4ae` from source, using Go 1.26.2. It does not publish or require a release. Changing that pin is an explicit workflow edit. An older published native CLI may not implement the timestamp, persistence, flag, and scheduling fixes required by this integration.

Each run ID ends in `shell` or `daemonitor`. Artifacts are named `build_process_watcher-compare-<attempt>` for shell and `build_process_watcher-compare-<attempt>-daemonitor` for Daemonitor. JSON report filenames also include the distinct run ID. Compare those exported JSON files using BPW's existing compare/import flow.

With remote monitoring enabled, both variants use the same BPW backend. Configure repository variables `BPW_BACKEND_URL` and `BPW_FRONTEND_URL` for custom endpoints, or leave them unset to use BPW's existing defaults. `export_to_bigquery` requires remote monitoring and a backend with BigQuery export configured.

## Use the new collector in another workflow

Set up Node 24, Go, and your JDK, then build the native executables before starting BPW:

```yaml
- name: Build pinned Daemonitor
  env:
    DAEMONITOR_COMMIT: d47b3901277ae0f3d858286c1e884ec35aa0d4ae
  run: bash path/to/bpw/scripts/build-daemonitor.sh "$DAEMONITOR_COMMIT" "$RUNNER_TEMP/daemonitor-bin"

- uses: ./path/to/bpw
  with:
    collector: daemonitor
    daemonitor_bin_dir: ${{ runner.temp }}/daemonitor-bin
    daemonitor_source_commit: d47b3901277ae0f3d858286c1e884ec35aa0d4ae
    run_id: comparison-${{ github.run_id }}-${{ github.run_attempt }}-daemonitor
    remote_monitoring: 'true'
    export_to_bigquery: 'true'

- run: ./gradlew assemble --no-daemon
```

The helper fetches the exact source SHA and writes `build-info.json` alongside `daemonitor-cli` and `daemonitor-cored`. BPW verifies the recorded SHA and both binary hashes when `daemonitor_source_commit` is set. A version string alone does not identify a source build. The binaries must be executable on the runner; this BPW integration currently supports Linux and macOS, not Windows.

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
node scripts/verify-collector-comparison.mjs /path/to/daemonitor-bin d47b3901277ae0f3d858286c1e884ec35aa0d4ae
```

The verification uses real native binaries and simultaneous Gradle/Kotlin HotSpot fixtures with freshness diagnostics enabled, exercises shell and Daemonitor variants, token refresh, metadata delivery, local reports, and finish-after-drain ordering. It also verifies that a simulated upload outage retains the outbox and prevents explicit run completion. It does not contact Firestore or BigQuery. Host process inspection and loopback/socket access are required.

The workflow is supplied for Linux validation; a local macOS pass does not establish that a hosted workflow has run. No workflow dispatch, release, or cloud deployment is part of the local implementation.
