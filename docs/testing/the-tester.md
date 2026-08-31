# TheTester Instructions

## Project Type

Build Process Watcher is validated as a GitHub Action plus hosted dashboard
workflow. The end-to-end test must prove that the Process Action for the main
branch captures build/process data, produces the expected local or remote
artifacts, and renders the resulting UI correctly.

TheTester must validate observable user behavior, not only process exit codes.

## Safety

Prefer existing recent GitHub Actions runs when they satisfy the scenario under
test.

TheTester is authorized to dispatch GitHub Actions workflows for this repository
when no suitable current-commit run exists for a required remote scenario.
Allowed dispatches include `test-action.yml`, `test-e2e-action.yml`, and
`predictive-contract-smoke.yml` (and equivalent Process Action / predictive
smoke workflows). Prefer `workflow_dispatch` on the commit or ref under test.
Wait for the dispatched run to finish and use its URLs, artifacts, and dashboard
links as evidence.

Do not merge changes, publish releases, delete remote data, or modify production
configuration. Do not dispatch deploy workflows. If remote credentials, workflow
permissions, or Firebase access are unavailable, report `BLOCKED` with the
missing dependency and the evidence.

When a scenario uses remote data, retain the GitHub Actions run URL, dashboard
run URL, compare URL, replay URL, build identifiers, screenshots, and relevant
logs in the final report.

## Scenario 1 - Offline Mode

Run the Process Action with the application configured in offline mode.

### Expected Behavior

- The Process Action completes successfully.
- The required builds/processes are executed locally.
- No data is posted or uploaded to the remote server.
- Generated diagrams are available locally.
- TheTester opens and inspects the resulting UI.
- Diagrams render correctly and contain the expected information.
- No errors are caused by the remote server being unavailable or disabled.

### Validation

Validate functional behavior:

- The action succeeds.
- No remote communication occurs.
- Local artifacts and data are generated.

Validate visual behavior:

- The main diagram loads.
- The diagram is not empty or broken.
- Expected nodes and relationships are present.
- No visible UI errors are present.

### Evidence

Capture the local artifact paths, command/action logs, local UI URL or file path,
screenshots of the rendered diagrams, and any console output proving that remote
communication was disabled.

## Scenario 2 - Remote Server Without Prediction

Run the Process Action configured to use the remote server with prediction
disabled.

The current workflow should trigger two different builds. Both builds must be
processed successfully before validating the resulting application.

### Execution

TheTester must:

1. Trigger or select a valid Process Action run.
2. Verify that the expected two builds are executed.
3. Verify that both builds publish and process their data through the remote
   server.
4. Wait until the action has completely finished.
5. Open the application and validate these screens in order:
   - Main screen
   - Compare screen
   - Replay screen

### Main Screen

Verify that:

- The processed builds appear.
- Expected diagrams and data are displayed.
- Build information corresponds to the builds triggered by the test.
- Navigation to other screens works.
- There are no loading, rendering, or server errors.

### Compare Screen

Verify that:

- The two builds can be selected and compared.
- The comparison loads successfully.
- Differences between the builds are displayed.
- Diagrams and associated information render correctly.
- Navigation and interactions work as expected.

### Replay Screen

Verify that:

- A processed build can be opened in Replay.
- Replay data loads successfully.
- The sequence or state represented by the build can be inspected.
- Replay controls and interactions work.
- The visualization does not contain obvious rendering errors or missing
  information.

### Evidence

Capture the GitHub Actions run URL, build identifiers, dashboard run URLs,
compare URL, replay URL, screenshots for each screen, relevant network/API
responses, and any console errors.

## Scenario 3 - Remote Server With Prediction

Run the Process Action using the remote server with prediction enabled.

This scenario must follow the behavior supported by the current prediction
implementation rather than assuming a future prediction workflow.

Prefer dispatching `.github/workflows/predictive-contract-smoke.yml` for the
ref under test and use that workflow's defaults. Do not assume legacy
checkpoint lists such as `30,60,180`. Production defaults are
`60,300,600,1200`; the smoke workflow runs long enough for all of those v1
checkpoint windows to become ready.

### Expected Behavior

TheTester must validate that:

- The Process Action completes successfully.
- Required builds are triggered and processed.
- Data is successfully sent to and retrieved from the remote server.
- Prediction is executed according to the current implementation.
- Prediction results are associated with the correct build/process data.
- Ready prediction checkpoints match the smoke contract for the run duration.
- The application continues to work correctly with prediction enabled.

TheTester must inspect all relevant UI produced by this flow, including:

- Main screen
- Compare screen, when applicable
- Replay screen, when applicable
- Prediction-specific information or visualizations exposed by the current
  implementation

### Prediction Validation

Do not determine whether a prediction is objectively correct unless the project
provides deterministic expected values.

Verify that:

- Prediction execution succeeds.
- Prediction results are returned.
- Results have the expected structure.
- Results belong to the expected build.
- Prediction information is displayed correctly.
- Enabling prediction does not break normal Main, Compare, or Replay workflows.

### Evidence

Capture the GitHub Actions run URL, build identifiers, prediction-related logs or
API responses, dashboard URLs, screenshots of prediction UI, and any console or
server errors.

## General Acceptance Criteria

For every scenario, TheTester must verify more than the process exit code.

A scenario only passes when:

- The Process Action completes successfully.
- Expected builds or actions actually occurred.
- Expected local or remote data was produced.
- The resulting application can be opened.
- Relevant screens render correctly.
- Required user interactions work.
- No unexpected errors appear in the application, browser console, process
  output, or server response.
- Generated data corresponds to the builds created during the test.

## Final Report Requirements

TheTester must include:

- Result: `PASS`, `FAIL`, or `BLOCKED`.
- Which scenarios were run and why.
- Build identifiers and GitHub Actions run URLs.
- Dashboard, compare, and replay URLs.
- Screenshots or explicit UI observations.
- Relevant command output, API responses, or logs.
- Any blocked dependency, missing permission, or unsafe external side effect.
- Whether the generated data corresponds to the builds created during the test.
