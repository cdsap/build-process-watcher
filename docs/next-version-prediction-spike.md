# Next-version prediction documentation spike

This records the findings and documentation work for
[#382](https://github.com/cdsap/build-process-watcher/issues/382). It is a dated
planning record, not a released-version guide. The next version is a maintainer
release decision. This spike does not enable providers, start a VM, publish a
release, or deploy the homepage.

## Baseline and evidence (2026-11-21)

Source validation used commit `88f0d0b85857dd71009cf827564fb33d75769214`.
Links below refer to files in that source snapshot; recheck them against the
chosen release before publishing consumer instructions.

| Surface | Verified finding | Follow-up |
| --- | --- | --- |
| [Action manifest](../action.yaml) and [feature resolution](../src/monitoring_features.ts) | Main accepts `prediction_mode` and `prediction_throttle_s`. Prediction defaults to `disabled`; active modes imply Remote Mode but do not enable finished-run BigQuery export. | #383, #384 |
| [Provider selection](../backend/internal/prediction/forecast_evaluator.go) | All four active modes can append optional `process_forecasts`. An unavailable provider or an empty/error response can leave forecasts absent. Selecting a mode does not prove inference succeeded. | #384 |
| [README](../README.md) | Lists modes and cadence but illustrates only `predict`, without a mode comparison or TabPFN VM caveat. Its new-input example is pinned to an incompatible `v0.7.0`. | #383, #384 |
| [Homepage source](../frontend/public/index.html) | The input row incorrectly says prediction requests BigQuery export and defaults to `false`. It omits the mode comparison and throttle input. | #385 |
| [Published v0.7.0 manifest](https://github.com/cdsap/build-process-watcher/blob/v0.7.0/action.yaml) and [release](https://github.com/cdsap/build-process-watcher/releases/tag/v0.7.0) | The manifest exposes `predictive_reliability`, not the new mode/cadence inputs. GitHub's latest-release response still identifies `v0.7.0`, published 2026-09-30. | #383 |
| [Backend auth options](../backend/internal/handlers/auth_options.go) | Rejects a nonempty former `predictive_reliability` parameter. Migration must describe a behavior change, not just an input rename. | #383 |
| [Forecast contract](process-forecast-contract.md) and [tester guidance](testing/the-tester.md) | The contract mixes historical spike language with the implemented live path. Tester expectations still require reliability checkpoint readiness. | #386 |

**Live verification is separate.** The issue records inspection of the
[served homepage](https://process-watcher.web.app/) on 2026-11-21 with the same
input-row errors. This worktree run could not independently retrieve that page
(web fetch failed; shell DNS resolution failed). The source findings above do
not establish the currently deployed revision or prove a documentation fix is
live. Provider deployment availability and inference were not tested.

## Public mode matrix

| Input value | Implemented prediction path | Availability wording |
| --- | --- | --- |
| `disabled` / omitted | No prediction request | Default; local monitoring remains possible. |
| `forecast` | TimesFM time-series forecasts | Requires the configured hosted provider. |
| `predict` | TabFM tabular prediction | Requires the configured hosted provider; distinct from TabPFN. |
| `bqml-boosted` | Trained BigQuery ML boosted trees | Requires the configured trained-model provider. |
| `tabpfn` | TabPFN GPU inference on a VM | **Disabled by default; requires an available VM/provider. Selecting the input does not start the VM or guarantee forecasts.** |

The TabPFN default/VM policy is a maintainer requirement, not a claim of live
availability. Check other providers' deployment availability before promising a
hosted service. Keep these distinctions explicit in README, homepage, migration
notes, and media captions:

- A selected `prediction_mode` input/output reports the request, not provider
  readiness or successful model inference. Missing forecasts can be valid.
- Active modes request future per-process heap-used/RSS values. They do not
  guarantee build failure, OOM, duration, or final-peak outcomes. Prediction is
  experimental and advisory; this spike establishes no forecast accuracy.
- `prediction_throttle_s` defaults to `20` and accepts integer seconds `1–3600`.
  It controls issuance cadence in elapsed-time buckets, separately from sample
  collection `interval` and the +10/+30/+60-second forecast horizons. Queueing
  and provider latency mean it is not a wall-clock delivery guarantee.
- `export_to_bigquery` remains an independent finished-run export choice.
  A provider's use of BigQuery does not enable that export.
- `process_forecasts` and optional timing fields may be missing in legacy data.
  Preserve existing export/import shapes and legacy dashboard behavior.

## Actionable follow-ups and order

The four issues already exist. This spike records their boundaries; their
implementation and publication are not completion claims for this record.

1. **[#383 — Release/version correctness and migration](https://github.com/cdsap/build-process-watcher/issues/383).**
   Establish the intended version and verify the exact action ref, manifest,
   and bundled action before advertising copyable new-input examples. Until
   then, identify examples as upcoming/unreleased or explicitly identify a
   verified development ref. Do not invent a version or move an existing tag.
   Coordinate README/homepage refs and release notes. Include before/after
   migration with a deliberate mode choice and independent export setting;
   distinguish new `process_forecasts` from historical reliability records.
   Do not extend examples to `/start` or `/composite`, which expose only
   `interval`. Publication requires separate authorization.
2. **[#384 — README and focused prediction guide](https://github.com/cdsap/build-process-watcher/issues/384).**
   Use the matrix above, a complete workflow and substitutions for all active
   modes, coordinated with #383. Cover defaults/ranges, Remote Mode, independent
   export, outputs, and the TabPFN caveat. Explain eligible process heap/RSS
   forecasts in MB, waiting for history, unavailable providers, delayed results,
   and possible last-value fallback without promising fallback on every failure.
   Describe actual versus forecast, issuance versus target time, Live/Replay,
   Latest/Last 3/All, expiry, latency, and accuracy sample counts/MAE/bias without
   accuracy guarantees. Link migration and distinguish independent
   `freshness_diagnostics` from prediction/export.
3. **[#385 — Homepage corrections and discovery](https://github.com/cdsap/build-process-watcher/issues/385).**
   Reuse the guide's mode comparison and #383's verified ref. Correct the
   prediction default/export row, add cadence, place the TabPFN VM caveat beside
   mode selection, and align the version pill, snippets, release highlights,
   guide links, and migration links. Add a preview or recorded demo from #386.
   Check anchors, keyboard navigation, and desktop/mobile readability within
   the existing static HTML/CSS/JS architecture.
4. **[#386 — Reference docs, media, and validation](https://github.com/cdsap/build-process-watcher/issues/386).**
   Refresh the contract and tester scenarios for timeline forecasts rather than
   reliability checkpoint windows. Review [job-offload guidance](prediction-job-offload.md):
   ingestion may work without a prediction scheduler/provider. Keep historical
   plans identifiable as history. Prepare a deterministic public-safe example
   and current screenshot/GIF showing actual memory, fixed issuance targets,
   horizons, and replay history controls, without removed flashing callouts.
   Explain selected mode versus observed method/fallback and available sample
   counts; label synthetic/demo data and provide useful captions/alt text.

#383's release-reference verification gates copyable examples in #384/#385.
#384 supplies shared terminology to #385; #386 supplies its media and final
cross-surface validation. Drafting can proceed before a release decision, but
must retain the unreleased status.

## Validation and completion gates

Record the following evidence separately when completing the follow-ups:

| Gate | Required evidence |
| --- | --- |
| Source correctness | Exact source commit; all five modes, defaults, range, export independence, migration, and TabPFN caveat agree across README, homepage, and reference docs. Review links, snippets, legacy fixtures, and current chart controls. |
| Published action compatibility | Chosen existing ref and resolved commit; its root manifest and built bundle support every advertised input/output. Do not infer this from main's source or a queued release job. |
| Documentation publication | After separately authorized deployment, retrieve the served page and verify version references, corrected rows, links, media, and desktop/mobile rendering. Source checks alone do not pass this gate. |
| Provider inference | When available, distinguish selected request, returned forecasts, observed method/fallback, and sample counts. Report an unavailable path explicitly; neither action success nor a demo proves live inference. Do not start TabPFN's VM for documentation validation. |

For this documentation-only spike, validate local links and review claims
against the named source files and existing focused feature-resolution/request
tests. There is no changed runtime behavior requiring a new regression test.
For follow-ups that change behavior, add/update the relevant regression tests
and follow `AGENTS.md` for Jest, frontend JavaScript syntax, action build, or
backend Bazel checks as applicable.

Completion of #383–#386 requires README, homepage, release/migration text,
reference docs, and representative media to agree with the chosen published
artifact and current dashboard, including the TabPFN caveat. Preserve legacy
JSON compatibility. Publish no private training data, feature engineering,
thresholds, infrastructure addresses, or deployment secrets. Provider enablement,
backend redesign, release publication, and accuracy claims remain outside this
spike's authorization.
