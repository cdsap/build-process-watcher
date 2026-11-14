# RFC: Smooth Live Charts and Time-Based Replay for Build Process Watcher

**Status:** Proposed / implementation-ready design  
**Reviewed:** 2026-11-13  
**Repository:** https://github.com/cdsap/build-process-watcher  
**Code baseline:** [`968964d1333c84b7e89a3ae11c647760b4f181af`](https://github.com/cdsap/build-process-watcher/tree/968964d1333c84b7e89a3ae11c647760b4f181af) (`main` at review)  
**Input:** User-provided 7.3-second, 1410×810, 60-fps screen recording, showing a 23-frame memory replay at **5×** speed.

## 1. Executive decision

**Keep Plotly.js initially. Introduce a shared, timestamp-driven playback controller, use stable axes and trace identities, and stop recreating the live dashboard on every poll.** Separate *continuous visual animation* from *actual sampled telemetry*. The charts should look fluid, but RSS/heap/GC/JIT values, maxima, spikes, data gaps, and tooltips must remain faithful to measured data.

Ship as three phases: **P0 replay motion + stable axes**, **P1 incremental live updates + state preservation**, **P2 unification across compare/unified replay/forecast and performance hardening**. Do not migrate chart libraries unless a focused Plotly prototype fails the performance target.

## 2. Observations and verified causes

### 2.1 Recording

The supplied recording shows the **Play / Pause / Reset** controls, *Frame N / 23*, and **5×** playback. Around the first few transitions, the total RSS trajectory jumps discretely as a new observation becomes visible; the Y-axis later expands as maxima increase. New process traces and legend entries appear partway through. The result is visually discontinuous even though the data points are valid.

The recording is a replay interaction, **not a demonstration of live HTTP polling**. The two paths share some chart code but have different fixes.

### 2.2 Code-level root causes

| Severity | Current implementation / evidence | Why it matters |
|---|---|---|
| High | Completed-run replay schedules *one sample at a time* with `setTimeout(nextTimestampDelta/speed)`, then awaits a complete `Plotly.react` before scheduling the next: [`runs/[runId].html` L1738–1756](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/frontend/public/runs/%5BrunId%5D.html#L1738-L1756). Offline replay does the same: [`replay.js` L320–420](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/frontend/public/replay.js#L320-L420). | Creates *stepwise* progression; adds rendering time to playback duration; reduces visible smoothness at higher speeds. |
| High | `getMemoryLayout()` specifies axis styling but no persistent time/value ranges: [`compare-shared.js` L931–951](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/frontend/public/compare-shared.js#L931-L951). | Plotly auto-ranges as new peaks arrive, making previously drawn lines move around. |
| High | Every live refresh calls `renderDashboard`, replacing `#content.innerHTML`: [`runs/[runId].html` L663–695](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/frontend/public/runs/%5BrunId%5D.html#L663-L695), [`L935–960`](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/frontend/public/runs/%5BrunId%5D.html#L935-L960); the live charts call `Plotly.newPlot`: [`L1305–1321`](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/frontend/public/runs/%5BrunId%5D.html#L1305-L1321), [`L2637–2646`](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/frontend/public/runs/%5BrunId%5D.html#L2637-L2646). | Live updates destroy/recreate DOM and plots; zoom, hover, focus and chart continuity can be lost. Repeated resize listeners also need lifecycle cleanup. |
| Medium | Replay rebuilds arrays up to `frameIndex+1`: [`compare-shared.js` L487–568](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/frontend/public/compare-shared.js#L487-L568); run dashboard only creates RSS/heap traces after first observation: [`runs/[runId].html` L1620–1658](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/frontend/public/runs/%5BrunId%5D.html#L1620-L1658). | Trace count and legend change during replay; trace indices can shift and redraws become more expensive. |
| Medium | Different replay clocks exist: unified [`experiment-layout.js` L485–518](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/frontend/public/experiment-layout.js#L485-L518), compare [`compare-shared.js` L1715–1728](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/frontend/public/compare-shared.js#L1715-L1728), forecast [`prediction-view.js` L535–569](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/frontend/public/prediction-view.js#L535-L569). | Compare uses a fixed *sample-rate* timer (`1000 / speed`) while other views use *timestamp deltas*; different playback semantics and drift. Forecast replaces SVG `innerHTML` each step. |
| Medium | Monitor default collection interval is **5 seconds**: [`action.yaml` L17–20](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/action.yaml#L17-L20); dashboard live refresh defaults to **60 seconds** with selectable 5–300 s: [`runs/[runId].html` L487–517](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/frontend/public/runs/%5BrunId%5D.html#L487-L517), [`L949–958`](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/frontend/public/runs/%5BrunId%5D.html#L949-L958). | Live UI can visibly lag collection even if the monitor samples every 5 s. Pure animation cannot correct stale data. |

**Data fidelity note:** `buildForwardFilledSeries` already includes a max-gap rule based on roughly twice the median sampling interval: [`compare-shared.js` L174–201](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/frontend/public/compare-shared.js#L174-L201). Keep its semantic breakpoints. Do **not** draw through gaps, introduce overshooting splines, or turn rendered interpolation into stored samples.

## 3. Goals, scope, non-goals

### Goals

1. Replay motion is time-based and smooth even when samples are 5 s apart, at 1×, 5×, 10× and faster speeds.
2. No distracting axis, legend or layout movement during normal replay.
3. During live monitoring, new data is incorporated without resetting the entire dashboard or a user's zoom/legend selections.
4. All views remain numerically accurate; absent process data and missing samples remain absent.
5. Lower rendering work and avoid animation-related memory leaks over long builds.

### Non-goals

- Altering JDK/Gradle/Kotlin sampling frequency, collector behavior, backend schema or BigQuery exports in this RFC.
- Creating an artificial higher-frequency *measurement* series.
- Imposing spline smoothing, averaging or filtering on resource metrics.
- Replacing Plotly in the initial release.
- Predictive interpolation or forecasting from future samples in a genuinely live run.

## 4. Product behavior

### 4.1 Replay (known full-run data)

- **Default:** `Smooth` replay with elapsed-time playhead and *full-run stable axes*.
- **Time axis:** fixed `[firstSampleTimestamp, lastSampleTimestamp]`, optionally with ~2% visual padding. At replay start, the complete time extent is visible, but **future data values are not**.
- **Memory axis:** fixed `[0, niceCeil(max RSS/heap/total RSS for selected run × 1.10)]`; calculate once from all original samples (or current visibility selection), not from each partial frame. For example a 1,270 MB peak could display 0–1,500 MB. Keep grid/ticks stationary. Use separate appropriate domains for GC, counters and rates.
- **Trace identity:** create one stable trace per `(run, process name, PID, metric)` and the total RSS trace; use Plotly `uid` and explicit `null` for samples before process appearance or within missing-data gaps. Pre-register legend labels and colors from the full run. Avoid shifting trace indices.
- **Progress:** elapsed-time cursor advances continuously. The primary label shows elapsed seconds; `Frame N / total` becomes secondary information and refers only to *actual sample frames already passed*. A vertical playhead is optional (test for performance and visual clarity).
- **Draw-on effect:** preserve all *confirmed* original vertices up to the playhead. For **RSS and heap only**, optionally add a transient line endpoint between adjacent known replay samples to smoothly reveal the existing straight segment. This endpoint is **presentation-only**: never treat it as measured, never use it for extrema, hover values, data export, GC/counter totals or alerts. A hover on the segment should reveal nearest **recorded** sample with timestamp, or label the interpolated point explicitly as visual-only. Reject interpolated spans crossing nulls or the gap threshold.
- **GC/JIT/classes:** do **not** interpolate cumulative counters/rates into invented observations; reveal actual points at their original timestamps, or animate a playhead over a step/line path without exposing intermediate values as measurements.
- **Scrubbing:** slider seeks by elapsed time (not array index); on `input`, pause, seek immediately, and render latest requested position. `Reset` cancels in-flight animation and returns to zero. `Pause` freezes the clock, then `Play` resumes from exactly that logical time. Changing speed does not jump the cursor.
- **Accessibility:** if `prefers-reduced-motion: reduce`, suppress fractional-point animation and playhead motion; use discrete true observations and keep functional Play/Pause/Seek. Provide keyboard-accessible controls and a readable elapsed label.

Optional view preferences after P0: axis `Fixed / Follow cursor` and replay `Smooth / Samples`. These are optional controls, not requirements for the minimum implementation. Fixed remains the default because it solves the most visible jumps in the recording.

### 4.2 Live monitoring (future data unknown)

- **Create the dashboard once.** On subsequent fetches, update only changed text, dynamic panels, and charts. Do not replace `#content.innerHTML` or call `Plotly.newPlot` for existing charts after initialization.
- **Incremental data handling:** normalize, sort/dedupe (sample ID/sequence when available, otherwise stable composite key), index by process and timestamp, compare with the last accepted snapshot, append truly new samples, and reconcile corrections via a controlled `Plotly.react`. Never append a duplicate sample after a repeated poll.
- **Plot API:** prefer `Plotly.extendTraces` for append-only stable series; use `Plotly.addTraces` for a new process; use `Plotly.react` for corrections/structural updates. Preserve trace UIDs and `layout.uirevision`. Avoid concurrent render calls; coalesce pending updates.
- **Y axis:** start at zero with 15–20% headroom. During an active run, *grow only* when the new measured maximum would consume the reserved headroom; do not shrink automatically on every poll. Use a short 200–350 ms transition for the occasional intentional expansion. Manual zoom switches the panel into `User range` until `Reset zoom / Follow` is clicked. Do not clip an actual spike just to keep the axis stable.
- **X axis:** offer `Follow live` (default, a sensible recent time window, e.g. 2 minutes, or automatic since-start for very short runs) and `Explore` (manual pan/zoom, persistent through fetches). If the chart is in follow mode, advance time bounds with the newest observed sample, not a guessed future measurement.
- **Arrival animation:** after a successful poll, reveal the newly received measured segment over 250–400 ms, if motion is allowed; preserve exact endpoint value. If additional data arrives while animating, cancel/coalesce to the newest truthful state. Do not draw beyond the latest confirmed observation.
- **Freshness:** show `Updated <n>s ago` / `Waiting for samples` and a subtle stale indication if data has not arrived, rather than faking a continuously changing graph. The existing opt-in freshness instrumentation can supply timings, but it should not be mandatory for this UI.
- **Polling:** respect the user's refresh selection, including 60 s default; consider recommending 5–10 s for an actively viewed build (and evaluate backend cost before changing the default). Use exactly one in-flight request; discard stale/out-of-order responses; on a temporary error keep the last successful chart rather than blanking the dashboard. Stop polling once `finished` is confirmed.
- **Lifecycle:** use a single resize observer / handler per live chart, clean up on navigation or chart removal, and avoid re-registering handlers every poll.

## 5. Proposed implementation architecture

### 5.1 New modules

```text
frontend/public/
  playback-clock.js          # monotonic timestamp-based state machine; no Plotly imports
  chart-viewport.js          # replay fixed-domain + live grow-only/follow/user-range policies
  chart-series-store.js      # stable trace IDs, normalized samples, gaps, corrections, deltas
  chart-renderer.js          # Plotly adapter: init/append/reconcile/seek/dispose; throttling
  live-run-controller.js     # poll orchestration, freshness, DOM update, in-flight guard
```

These may be combined into fewer files if desired, but keep clock, data transformations and DOM/Plotly effects separately testable. Preserve the current plain JavaScript frontend approach; no framework rewrite is needed.

### 5.2 Playback clock contract

```js
createPlaybackClock({timestamps, speed, onPosition, onStateChange})
  .play()                // continuous logical time, respects speed
  .pause()               // retain exact cursor
  .seekTo(ms)            // logical elapsed ms, clamp to [0, duration]
  .setSpeed(multiplier)  // preserve current cursor
  .reset()
  .destroy()             // cancel RAF + listeners
```

**Clock algorithm (illustrative, not drop-in implementation):**

```js
// Timestamp-driven, not "wait one sample, then wait another".
function play() {
  if (playing) return;
  playing = true;
  anchorCursorMs = cursorMs;
  anchorWallMs = performance.now();
  requestFrame();
}

function tick(nowMs) {
  if (!playing) return;
  cursorMs = Math.min(durationMs,
    anchorCursorMs + (nowMs - anchorWallMs) * speed);
  onPosition(cursorMs);  // queue a coalesced chart update, do not await Plotly
  if (cursorMs < durationMs) requestFrame();
  else pauseAtEnd();
}

function seekTo(nextMs) {
  cancelAnimationFrame(rafId);
  cursorMs = Math.max(0, Math.min(durationMs, nextMs));
  anchorCursorMs = cursorMs;
  anchorWallMs = performance.now();
  renderNow(cursorMs); // a generation token rejects stale async render completions
  if (playing) requestFrame();
}
```

Call `onPosition` at browser animation cadence, but **throttle Plotly updates independently** to a configurable target (start at **12–15 chart updates/s**, not 60 `Plotly.react` calls/s). The playhead clock must not slow down because a plot render is slow. When the renderer is busy, retain the most recent target position and skip obsolete intermediate visual frames. Use binary search into sorted timestamps to find `lowerIndex` / `upperIndex` in O(log n).

**Example reveal math for replay RSS/heap only:** Given actual samples `(t0, y0)` and `(t1, y1)` with no gap, at playhead `t`: `alpha = clamp((t - t0)/(t1 - t0), 0, 1)` and `y_visual = y0 + alpha * (y1 - y0)`. Append `(t, y_visual)` *only to the transient rendering layer*, not to `samples`, exports, hover datasets or validation. This draws a progressively longer straight segment without changing its shape or maximum.

### 5.3 Renderer/viewport contract

```js
chartRenderer.init(container, {series, axisPolicy, mode});
chartRenderer.revealAt(playheadMs);       // replay; coalesces renders
chartRenderer.append(samplesDelta);      // live; extendTraces where safe
chartRenderer.reconcile(snapshot);       // corrections/process changes
chartRenderer.setViewportPolicy(policy); // fixed / follow / user range
chartRenderer.dispose();                 // purge/listener cleanup
```

**Stable axes:** `chart-viewport.js` calculates domains once per replay/run and owns changes. `layout.uirevision = 'run:' + runId + ':panel:' + panelKey`, with `xaxis.uirevision` and `yaxis.uirevision` as needed. Explicit user actions must determine when to switch follow mode or reset the range. For replay, do not send different autorange layouts each frame. For live, explicit axis growth can call `Plotly.relayout`; test preservation of user zoom.

**Stable traces:** Plotly `uid` should be derived from run ID, process identity and metric, not array position. Use stable process/metric order and null arrays for not-yet-seen processes in a *known* replay. When a new process appears live, register it exactly once. Maintain checkbox/legend state in a shared keyed store. Preserve trace `connectgaps: false` and the existing gap logic.

**Rendering strategy to prototype:**

1. **Preferred low-risk path:** one initial `Plotly.newPlot` per panel, then `Plotly.react` on coalesced replay visual updates (with stable plot structure/axis ranges) and `Plotly.extendTraces` for live append-only changes. Benchmark memory and GC panels together.
2. **Try `Plotly.animate`** for same-length `scatter` trace transitions with `redraw: false` and `line.simplify: false`; Plotly documents its animation limitations. Do **not** assume it supports efficient dynamic trace counts or arbitrary path lengths without a prototype.
3. **Fallback:** if 12–15 fps Plotly rendering cannot be sustained on representative runs, keep fixed scales + real-time accurate playhead and render at a lower cadence, or prototype a **Canvas/SVG reveal layer** over an immutable Plotly base. Avoid manipulating Plotly's private generated SVG DOM without encapsulation and regression tests.

**Do not** switch every line to `shape: 'spline'` or apply a moving average just to improve appearance: smoothing metric *values* could conceal short-lived RSS spikes or imply measurements not made.

## 6. Integration points / work packages

### P0 — Replay stability and smoothness (first PR)

**Files:** new `playback-clock.js`, `chart-viewport.js` and small Plotly adapter; [`runs/[runId].html`](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/frontend/public/runs/%5BrunId%5D.html), [`replay.js`](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/frontend/public/replay.js), [`compare-shared.js`](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/frontend/public/compare-shared.js).

- Replace per-sample `setTimeout` loop in the completed-run RSS replay and standalone Replay view with the same logical clock.
- Lock known-run X/Y domains and register stable trace ordering.
- Implement progressive line reveal for RSS/heap, with no hover/export pollution; keep GC/counters exact.
- Keep Play/Pause/Reset/speed/scrub functionality; update elapsed label by time.
- Add tests using the exact **23-frame / 5×** pattern in the recording. Preserve original sample values.

**Definition of done:** playback from start to finish exhibits no axis jumps, no legend reflow from newly appearing processes, and no accumulating delay caused by render promises.

### P1 — Live dashboard incremental update (second PR)

**Files:** new `live-run-controller.js`, chart-series store/adapter, [`runs/[runId].html`](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/frontend/public/runs/%5BrunId%5D.html) and mirror [`runs/demo.html`](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/frontend/public/runs/demo.html) (currently contains very similar dashboard logic).

- Split `renderDashboard()` into `mountDashboardOnce()` and `updateDashboard(state, delta)`; retain static DOM/chart nodes.
- Avoid `Plotly.newPlot` for an already-mounted plot. Append/reconcile samples and add process traces without tearing down components.
- Implement grow-only Y scaling, optional follow-time viewport, manual zoom persistence, panel/legend state preservation.
- Consolidate resize observers/listeners and implement cleanup.
- Poll using one request at a time; keep existing plot during transient errors and display freshness.
- When finished, transition live chart to final state without a full-page flash; allow replay on the captured final run.

**Definition of done:** zoom/legend/selected panel do not reset on three successive refreshes; live chart node is not replaced; duplicate fetches don't double-add points.

### P2 — Consistency, forecast and scale (third PR)

**Files:** [`experiment-layout.js`](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/frontend/public/experiment-layout.js), [`compare-shared.js`](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/frontend/public/compare-shared.js), [`prediction-view.js`](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/frontend/public/prediction-view.js), [`chart-studio.js`](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/frontend/public/chart-studio.js).

- Use one playback clock for unified view, compare and process forecast; remove inconsistent sample-count-based compare timing.
- Replace forecast's per-frame full SVG `innerHTML` replacement with cached elements/path updates or a coalesced chart layer.
- Optimize sample indexing (current live `renderChart` does repeated per-process/per-time `.filter()` lookups) and benchmark large runs.
- Support paused/hidden tabs, `prefers-reduced-motion`, chart resizing, process start/exit and long missing intervals.
- Keep prediction checkpoint timing and values unchanged; no fractional interpolation of predictions/risk status.

## 7. Edge cases and correctness rules

1. **Sparse/irregular timestamps:** cursor speed is based on elapsed timestamps, not sample count. At a 5× speed, 10 seconds of build time consumes 2 seconds of wall time unless skipped for performance; visible intermediate motion may be throttled, but total duration stays correct.
2. **Missing samples:** honor `connectgaps: false` and the current gap policy; never draw across a missing interval. Stop extending a live line at the last confirmed observation.
3. **Process entry/exit:** do not show RSS/heap before the first actual sample or after confirmed exit; legend identity/order stays stable in replay. Treat same PID for distinct processes/launches as distinct if data schema can disambiguate; otherwise preserve existing `(Name, PID)` behavior.
4. **Total RSS:** compute from the existing normalized total-series algorithm, not by summing visually interpolated RSS at arbitrary times. Replay animation should reveal the precomputed total path only.
5. **Counters/rates:** retain timestamped metric semantics. Do not interpolate counter resets or rate values as if sampled.
6. **Out-of-order/duplicate/live corrections:** reconcile by sample identity and timestamp; ensure last response wins only if newer. Avoid concurrent promises rendering an older seek after a newer seek.
7. **No data / one sample:** chart is stable and controls behave correctly; no division by zero.
8. **Speed changes / seek / pause / background tab:** preserve the logical cursor; no requestAnimationFrame drift or burst of past frames on return.
9. **Visibility/zoom/export:** trace visibility persists when update occurs; PNG/SVG/JSON exports are based on actual samples, and any presentation-only endpoint is explicitly excluded from exports.
10. **Predictions:** don't inadvertently reuse actual-sample interpolation for checkpoint confidence, model output, or forecast risk.

## 8. Verification and acceptance criteria

### Automated tests

- **Clock unit tests:** irregular sample timestamps, pause/resume, 1×/5×/50× speed changes, end-of-run, seek races, background pause, generation-token cancellation, monotonic elapsed time.
- **Series tests:** exact original vertices; no added measurements; correct null gaps; process appearing midway; total RSS and GC stable; duplicate/corrected samples; counter resets.
- **Axis tests:** replay fixed bounds remain unchanged across every frame; live bounds only grow automatically; manual zoom persists until reset; value spikes never clip.
- **DOM tests:** same plot node survives live refresh; legend checkboxes, zoom and panel focus persist; single resize listener; stale/finished states.
- **Browser tests:** extend existing Jest tests and add Playwright scenarios for completed run, offline Replay, Compare, unified replay and live updates. Keep mobile and accessibility regressions in scope. Existing accessibility test: [`__tests__/replay-accessibility.test.ts`](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/__tests__/replay-accessibility.test.ts).

### Performance gates (proposed thresholds; measure on representative Chrome desktop and mobile before release)

| Scenario | Target |
|---|---|
| Supplied 23-frame replay at 5× | X/Y domains constant; no legend reflow; no visible full-chart flash. |
| Playback duration | ≤5% drift from expected `runDuration/speed` in a visible, foreground tab, excluding intentional seek/pause. |
| Replay render pacing | Target 12–15 actual chart updates/s on normal desktop for a simple memory panel; never queue multiple stale Plotly updates. |
| Render cost | p95 Plotly update under 50 ms for short runs; if exceeded, coalesce/degrade before sacrificing correctness. |
| 1,000 timestamps × 10 process series | No unbounded growth in render backlog or DOM/chart instance count; evaluate time and heap in DevTools. |
| Live refresh × 10 cycles | No whole-dashboard remount or flash; stable user zoom/legend; no duplicate plot/resize handlers. |
| Reduced motion | No fractional endpoint animation, but all controls and actual observations remain usable. |

Capture a before/after replay video and a Chrome Performance trace on the same sample dataset. Instrument `fetch_duration_ms`, `render_duration_ms`, `render_queue_depth`, `render_calls`, `new_plot_count`, `actual_samples_count`, `visible_cursor_ms`, and `playback_drift_ms`. Distinguish browser rendering latency from the existing collection → backend delay (covered by optional freshness diagnostics).

## 9. Alternative approaches / trade-offs

| Option | Benefits | Limitations | Verdict |
|---|---|---|---|
| Fixed axes + existing sample-by-sample `Plotly.react` | Very small diff; immediately reduces visual scale jumping | Lines still jump and playback still drifts because of awaited rendering | **Good quick stabilization, not final** |
| Stable Plotly chart + time-based clock + throttled coalesced updates | Reuses current Plotly controls, exports and traces; accurate underlying data; manageable scope | Need to benchmark redraw cost and handle dynamic trace lengths | **Recommended P0** |
| `Plotly.animate` scatter transitions | Built-in interpolation and easing | Only some trace types/transitions supported; full redraw and changing path length can be problematic | **Prototype before relying on it** |
| ECharts dynamic `setOption` transitions | Elegant built-in diff/update animation | Migration of plot interactions, exports, predictions, compare, tests and styling | **Only if Plotly PoC misses targets** |
| SVG/Canvas custom rendering layer | Potentially best fluidity for many traces | Highest complexity and risk of visual/data divergence; double hover/zoom alignment | **Later fallback** |

## 10. References

### Repository (reviewed at commit `968964d`)

1. [Run dashboard polling and render path](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/frontend/public/runs/%5BrunId%5D.html#L663-L715).
2. [Run dashboard DOM rebuild](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/frontend/public/runs/%5BrunId%5D.html#L935-L960).
3. [Run dashboard replay loop](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/frontend/public/runs/%5BrunId%5D.html#L1701-L1788).
4. [Offline replay frame reconstruction and scheduler](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/frontend/public/replay.js#L320-L452).
5. [Shared trace creation](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/frontend/public/compare-shared.js#L487-L568).
6. [Shared memory plot layout](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/frontend/public/compare-shared.js#L931-L970).
7. [Shared forward-fill with gap limit](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/frontend/public/compare-shared.js#L174-L215).
8. [Unified replay scheduler](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/frontend/public/experiment-layout.js#L485-L518).
9. [Compare replay tick](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/frontend/public/compare-shared.js#L1709-L1747).
10. [Prediction/forecast replay](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/frontend/public/prediction-view.js#L535-L569).
11. [Collection interval default](https://github.com/cdsap/build-process-watcher/blob/968964d1333c84b7e89a3ae11c647760b4f181af/action.yaml#L17-L20).

### External technical references

12. [Plotly.js function reference](https://plotly.com/javascript/plotlyjs-function-reference/) — `newPlot`, `react`, `extendTraces`, `animate` and API trade-offs.
13. [Plotly.js: Animations](https://plotly.com/javascript/animations/) — scatter interpolation limitations, redraw behavior, `redraw: false`, line simplification.
14. [Plotly.js: UI revision](https://plotly.com/javascript/uirevision/) — preserving zoom and other user interaction through `Plotly.react`.
15. [Plotly.js: layout reference](https://plotly.com/javascript/reference/layout/) — `uirevision`, `datarevision`, transitions and explicit axis ranges.
16. [MDN: `requestAnimationFrame`](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame) — timestamp-based animation, refresh rate and throttling in hidden tabs.
17. [MDN: `visibilitychange`](https://developer.mozilla.org/en-US/docs/Web/API/Document/visibilitychange_event) — stopping or pausing unnecessary hidden-tab animation.
18. [MDN: `prefers-reduced-motion`](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/%40media/prefers-reduced-motion) — respect animation accessibility settings.
19. [MDN: Resize Observer API](https://developer.mozilla.org/en-US/docs/Web/API/Resize_Observer_API) — element resizing without accumulating `window.resize` listeners.
20. [Apache ECharts: Data Transition](https://echarts.apache.org/handbook/en/how-to/animation/transition/) — alternative diff-based animation option.
21. [Grafana: Time-series axis controls](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/visualizations/time-series/) — soft/hard min/max trade-offs and stable Y-axis presentation.
22. [Chrome DevTools Performance reference](https://developer.chrome.com/docs/devtools/performance/reference) — measuring frame drop and rendering cost.

## 11. Recommended immediate experiment

Before a large refactor, run the same 23-frame source data through **two small Plotly prototypes**:

**A.** Current per-frame `Plotly.react` with precomputed full-run X/Y ranges and stable trace placeholders.  
**B.** Same visual design plus monotonic playback cursor and 12–15 fps coalesced `Plotly.react`, with a fractional draw-on endpoint for RSS/heap.

Record both at 5×. Compare p95 render cost, playback duration drift, screenshot stability and sample accuracy. If B meets the gates, implement P0; otherwise try Plotly's animation API or a dedicated reveal layer. This experiment isolates the two real sources of jerkiness—*chart rescaling* and *sample-step playback*—before touching the backend or changing libraries.
