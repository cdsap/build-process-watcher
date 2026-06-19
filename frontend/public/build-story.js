(function (global) {
    const STORAGE_SCOPE_KEY = 'bpwBuildStoryScope';
    const DEFAULT_SCOPE = 'phase';

    let state = {
        samples: [],
        runId: '',
        replayData: null,
        timestamps: [],
        elapsedSeconds: [],
        phases: [],
        selectedPhaseId: '',
        cursorFrame: 0,
        scope: DEFAULT_SCOPE,
        useElapsedAxis: true,
        visible: false,
        bound: false
    };

    function shared() {
        return global.BpwCompareShared || {};
    }

    function isFiniteNumber(value) {
        return value !== null && value !== undefined && Number.isFinite(Number(value));
    }

    function formatSeconds(value) {
        if (!Number.isFinite(value)) return '0s';
        if (value < 60) return `${Math.round(value)}s`;
        const minutes = Math.floor(value / 60);
        const seconds = Math.round(value % 60);
        return `${minutes}m ${seconds}s`;
    }

    function formatMetric(value, unit) {
        if (!Number.isFinite(value)) return 'N/A';
        if (unit === 'mb') return `${Math.round(value)} MB`;
        if (unit === 'seconds') return `${value.toFixed(2)} s`;
        if (unit === 'ratio') return value.toFixed(2);
        if (unit === 'rate') return value.toFixed(1);
        return Math.round(value).toLocaleString();
    }

    function valueAt(series, index) {
        if (!Array.isArray(series)) return null;
        for (let i = Math.min(index, series.length - 1); i >= 0; i -= 1) {
            if (isFiniteNumber(series[i])) return Number(series[i]);
        }
        return null;
    }

    function maxInRange(series, start, end) {
        if (!Array.isArray(series)) return null;
        let max = null;
        for (let i = Math.max(0, start); i <= Math.min(end, series.length - 1); i += 1) {
            if (!isFiniteNumber(series[i])) continue;
            const value = Number(series[i]);
            max = max === null ? value : Math.max(max, value);
        }
        return max;
    }

    function deltaInRange(series, start, end) {
        const first = valueAt(series, start);
        const last = valueAt(series, end);
        if (first === null || last === null) return null;
        return last - first;
    }

    function percentile(values, p) {
        const sorted = values.filter(isFiniteNumber).map(Number).sort((a, b) => a - b);
        if (!sorted.length) return null;
        const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
        return sorted[index];
    }

    function windowBounds(center, radius, maxIndex) {
        return {
            start: Math.max(0, center - radius),
            end: Math.min(maxIndex, center + radius)
        };
    }

    function pushPhase(phases, candidate) {
        if (!candidate || candidate.end <= candidate.start) return;
        const exists = phases.some((phase) => (
            phase.label === candidate.label &&
            Math.abs(phase.start - candidate.start) <= 1 &&
            Math.abs(phase.end - candidate.end) <= 1
        ));
        if (!exists) phases.push(candidate);
    }

    function processContribution(start, end) {
        const rows = [];
        Object.entries(state.replayData?.series || {}).forEach(([processKey, def]) => {
            const [name, pid] = processKey.split('|');
            const rssStart = valueAt(def.rss, start);
            const rssEnd = valueAt(def.rss, end);
            const heapStart = valueAt(def.heap, start);
            const heapEnd = valueAt(def.heap, end);
            const rssDelta = rssStart !== null && rssEnd !== null ? rssEnd - rssStart : null;
            const heapDelta = heapStart !== null && heapEnd !== null ? heapEnd - heapStart : null;
            const peakRss = maxInRange(def.rss, start, end);
            if (rssStart === null && rssEnd === null && heapStart === null && heapEnd === null) return;
            rows.push({
                name,
                pid,
                rssStart,
                rssEnd,
                rssDelta,
                heapDelta,
                peakRss
            });
        });
        rows.sort((a, b) => (b.peakRss || 0) - (a.peakRss || 0));
        return rows;
    }

    function dominantProcess(start, end) {
        const row = processContribution(start, end)[0];
        return row ? `${row.name} PID:${row.pid}` : 'No dominant process';
    }

    function metricDeltas(start, end) {
        const data = state.replayData || {};
        let gcDelta = null;
        let jitDelta = null;
        let classesDelta = null;
        let classRatePeak = null;
        let jitRatePeak = null;
        let ratioPeak = null;
        Object.values(data.series || {}).forEach((def) => {
            const gc = deltaInRange(def.gc, start, end);
            const jit = deltaInRange(def.jitTime, start, end);
            const classesLoaded = deltaInRange(def.classesLoaded, start, end);
            const classRate = maxInRange(def.classRate, start, end);
            const jitRate = maxInRange(def.jitRate, start, end);
            const ratio = maxInRange(def.ratio, start, end);
            if (gc !== null) gcDelta = Math.max(gcDelta || 0, gc);
            if (jit !== null) jitDelta = Math.max(jitDelta || 0, jit);
            if (classesLoaded !== null) classesDelta = Math.max(classesDelta || 0, classesLoaded);
            if (classRate !== null) classRatePeak = Math.max(classRatePeak || 0, classRate);
            if (jitRate !== null) jitRatePeak = Math.max(jitRatePeak || 0, jitRate);
            if (ratio !== null) ratioPeak = Math.max(ratioPeak || 0, ratio);
        });
        return {
            totalRssDelta: deltaInRange(data.totalRss, start, end),
            totalRssPeak: maxInRange(data.totalRss, start, end),
            gcDelta,
            jitDelta,
            jitRatePeak,
            classesDelta,
            classRatePeak,
            ratioPeak
        };
    }

    function confidenceFor(delta, baseline) {
        if (!Number.isFinite(delta) || !Number.isFinite(baseline) || baseline <= 0) return 'low';
        if (Math.abs(delta) >= baseline * 0.3) return 'high';
        if (Math.abs(delta) >= baseline * 0.12) return 'medium';
        return 'low';
    }

    function makePhase(id, label, start, end, dominantMetric, baseline, badges) {
        const deltas = metricDeltas(start, end);
        const primaryDelta = dominantMetric === 'Memory'
            ? deltas.totalRssDelta
            : dominantMetric === 'GC'
                ? deltas.gcDelta
                : dominantMetric === 'JIT'
                    ? deltas.jitDelta
                    : deltas.classesDelta;
        return {
            id,
            label,
            start,
            end,
            dominantMetric,
            confidence: confidenceFor(primaryDelta || 0, baseline),
            dominantProcess: dominantProcess(start, end),
            badges: badges || [],
            sampleCount: Math.max(1, end - start + 1),
            deltas
        };
    }

    function detectPhases() {
        const data = state.replayData;
        const timestamps = state.timestamps;
        if (!data || !timestamps.length) return [];
        const maxIndex = timestamps.length - 1;
        if (timestamps.length < 4) {
            return [makePhase('full-run', 'Full run', 0, maxIndex, 'Memory', 1, ['limited samples'])];
        }

        const phases = [];
        const radius = Math.max(2, Math.round(timestamps.length * 0.07));
        const totalRss = data.totalRss || [];
        const rssValues = totalRss.filter(isFiniteNumber).map(Number);
        const rssMin = rssValues.length ? Math.min(...rssValues) : 0;
        const rssMax = rssValues.length ? Math.max(...rssValues) : 0;
        const rssRange = Math.max(1, rssMax - rssMin);
        const peakRssIndex = totalRss.findIndex((value) => value === rssMax);

        const earlyEnd = Math.max(1, Math.min(maxIndex, Math.round(timestamps.length * 0.16)));
        const earlyDeltas = metricDeltas(0, earlyEnd);
        if ((earlyDeltas.jitRatePeak || 0) > 0 || (earlyDeltas.classRatePeak || 0) > 0) {
            pushPhase(phases, makePhase('warmup', 'Warmup', 0, earlyEnd, earlyDeltas.jitRatePeak ? 'JIT' : 'Classes', Math.max(1, earlyDeltas.jitRatePeak || earlyDeltas.classRatePeak || 1), ['startup']));
        }

        if (peakRssIndex >= 0) {
            const bounds = windowBounds(peakRssIndex, radius, maxIndex);
            pushPhase(phases, makePhase('peak-pressure', 'Peak pressure', bounds.start, bounds.end, 'Memory', rssRange, ['RSS peak']));
        }

        const growthThreshold = rssRange * 0.18;
        let bestGrowth = null;
        for (let i = 0; i <= maxIndex - radius; i += 1) {
            const end = Math.min(maxIndex, i + radius);
            const delta = deltaInRange(totalRss, i, end);
            if (delta === null || delta < growthThreshold) continue;
            if (!bestGrowth || delta > bestGrowth.delta) bestGrowth = { start: i, end, delta };
        }
        if (bestGrowth) {
            pushPhase(phases, makePhase('memory-growth', 'Memory growth', bestGrowth.start, bestGrowth.end, 'Memory', rssRange, ['RSS rising']));
        }

        const ratioValues = [];
        Object.values(data.series || {}).forEach((def) => ratioValues.push(...(def.ratio || [])));
        const ratioHigh = percentile(ratioValues, 0.85);
        if (ratioHigh !== null) {
            let ratioIndex = -1;
            Object.values(data.series || {}).some((def) => {
                ratioIndex = (def.ratio || []).findIndex((value) => isFiniteNumber(value) && Number(value) >= ratioHigh);
                return ratioIndex >= 0;
            });
            if (ratioIndex >= 0) {
                const bounds = windowBounds(ratioIndex, radius, maxIndex);
                pushPhase(phases, makePhase('heap-pressure', 'Heap pressure', bounds.start, bounds.end, 'Memory', Math.max(1, ratioHigh), ['high Heap/RSS']));
            }
        }

        const scanMetricPeak = (seriesKey) => {
            let best = null;
            Object.values(data.series || {}).forEach((def) => {
                (def[seriesKey] || []).forEach((value, index) => {
                    if (!isFiniteNumber(value)) return;
                    if (!best || Number(value) > best.value) best = { index, value: Number(value) };
                });
            });
            return best;
        };

        const jitPeak = scanMetricPeak('jitRate');
        if (jitPeak && jitPeak.value > 0) {
            const bounds = windowBounds(jitPeak.index, radius, maxIndex);
            pushPhase(phases, makePhase('compilation-spike', 'Compilation spike', bounds.start, bounds.end, 'JIT', jitPeak.value, ['JIT peak']));
        }

        const classPeak = scanMetricPeak('classRate');
        if (classPeak && classPeak.value > 0) {
            const bounds = windowBounds(classPeak.index, radius, maxIndex);
            pushPhase(phases, makePhase('class-loading-burst', 'Class loading burst', bounds.start, bounds.end, 'Classes', classPeak.value, ['class rate peak']));
        }

        let bestGc = null;
        Object.values(data.series || {}).forEach((def) => {
            for (let i = 0; i <= maxIndex - radius; i += 1) {
                const end = Math.min(maxIndex, i + radius);
                const delta = deltaInRange(def.gc, i, end);
                if (delta === null || delta <= 0) continue;
                if (!bestGc || delta > bestGc.delta) bestGc = { start: i, end, delta };
            }
        });
        if (bestGc) {
            pushPhase(phases, makePhase('gc-churn', 'GC churn', bestGc.start, bestGc.end, 'GC', Math.max(1, bestGc.delta), ['GC rising']));
        }

        let drop = null;
        for (let i = 1; i <= maxIndex; i += 1) {
            if (!isFiniteNumber(totalRss[i - 1]) || !isFiniteNumber(totalRss[i])) continue;
            const delta = Number(totalRss[i]) - Number(totalRss[i - 1]);
            if (delta > -rssRange * 0.2) continue;
            if (!drop || delta < drop.delta) drop = { index: i, delta };
        }
        if (drop) {
            const bounds = windowBounds(drop.index, radius, maxIndex);
            pushPhase(phases, makePhase('drop-off', 'Drop-off', bounds.start, bounds.end, 'Memory', rssRange, ['RSS drop']));
        }

        if (!phases.length) {
            phases.push(makePhase('full-run', 'Full run', 0, maxIndex, 'Memory', rssRange, ['low variation']));
        }

        phases.sort((a, b) => a.start - b.start || a.end - b.end);
        return phases.slice(0, 8);
    }

    function phaseTime(phase) {
        const start = state.elapsedSeconds[phase.start] || 0;
        const end = state.elapsedSeconds[phase.end] || start;
        return `${formatSeconds(start)} - ${formatSeconds(end)}`;
    }

    function summarySentence(phase) {
        const d = phase.deltas || {};
        if (phase.label === 'Warmup') {
            if ((d.classRatePeak || 0) > (d.jitRatePeak || 0)) return `Classes loaded quickly during ${phaseTime(phase)}.`;
            return `JIT activity peaked during ${phaseTime(phase)}.`;
        }
        if (phase.label === 'GC churn') return `GC time rose during ${phaseTime(phase)} while memory remained visible for comparison.`;
        if (phase.label === 'Drop-off') return `Total RSS dropped during ${phaseTime(phase)} while process contribution changed.`;
        if (phase.label === 'Heap pressure') return `Heap/RSS reached a high point during ${phaseTime(phase)}.`;
        if (phase.label === 'Class loading burst') return `Class loading activity peaked during ${phaseTime(phase)}.`;
        if (phase.label === 'Compilation spike') return `JIT activity peaked during ${phaseTime(phase)}.`;
        return `Total RSS moved most visibly during ${phaseTime(phase)}.`;
    }

    function defaultOverlayForPhase(phase) {
        const map = {
            'Warmup': ['classesLoaded', 'jitRate'],
            'Compilation spike': ['jitTime', 'jitRate'],
            'Class loading burst': ['classesLoaded', 'classRate'],
            'Memory growth': ['rss', 'ratio'],
            'Heap pressure': ['ratio', 'gc'],
            'GC churn': ['gc', 'rss'],
            'Peak pressure': ['rss', 'gc'],
            'Drop-off': ['rss', 'classesLoaded']
        };
        const available = shared().getAvailableOverlayMetrics?.(state.samples) || ['rss'];
        const pair = map[phase.label] || ['rss', 'gc'];
        const a = available.includes(pair[0]) ? pair[0] : available[0];
        const b = available.includes(pair[1]) && pair[1] !== a ? pair[1] : '';
        return { a, b };
    }

    function metricLabel(metric) {
        const catalog = shared().METRIC_CATALOG || {};
        return catalog[metric]?.label || metric || 'Metric';
    }

    function phaseDuration(phase) {
        const start = state.elapsedSeconds[phase.start] || 0;
        const end = state.elapsedSeconds[phase.end] || start;
        return Math.max(0, end - start);
    }

    function scopedRange(phase) {
        if (state.scope === 'full') return null;
        const maxIndex = Math.max(0, state.timestamps.length - 1);
        let bounds = { start: phase.start, end: phase.end };
        if (state.scope === 'cursor') {
            const radius = Math.max(2, Math.round(state.timestamps.length * 0.05));
            bounds = windowBounds(state.cursorFrame, radius, maxIndex);
        }
        const x = state.useElapsedAxis
            ? state.elapsedSeconds
            : state.timestamps.map((ts) => new Date(ts));
        return [x[bounds.start], x[bounds.end]];
    }

    function renderFocusChart(phase) {
        const host = document.getElementById('bpw-build-story-chart');
        if (!host || typeof Plotly === 'undefined' || !shared().buildOverlayTraces || !state.replayData) {
            return Promise.resolve();
        }
        const overlay = defaultOverlayForPhase(phase);
        const frameIndex = state.scope === 'full'
            ? Math.max(0, state.timestamps.length - 1)
            : Math.max(phase.end, state.cursorFrame);
        const traces = shared().buildOverlayTraces(
            state.replayData,
            state.timestamps,
            frameIndex,
            overlay.a,
            overlay.b || null,
            state.useElapsedAxis ? state.elapsedSeconds : null
        );
        const layout = shared().getOverlayLayout(overlay.a, overlay.b || null);
        if (state.useElapsedAxis) {
            layout.xaxis = {
                ...layout.xaxis,
                title: 'Elapsed (s)',
                tickformat: null,
                type: 'linear'
            };
        }
        const range = scopedRange(phase);
        if (range) layout.xaxis = { ...layout.xaxis, range };
        layout.title = `${phase.label}: ${phase.dominantMetric}`;
        layout.height = 420;
        layout.margin = { ...(layout.margin || {}), t: 54, b: 82 };
        return Plotly.react(
            host,
            traces,
            layout,
            shared().getOverlayConfig?.(`bpw-build-story-${state.runId}`) || { responsive: true }
        );
    }

    function renderEvidence(phase) {
        const rows = processContribution(phase.start, phase.end).slice(0, 5);
        const d = phase.deltas || {};
        const tableRows = rows.length ? rows.map((row) => `
            <tr>
                <td>${row.name}<span>PID ${row.pid}</span></td>
                <td>${formatMetric(row.rssDelta, 'mb')}</td>
                <td>${formatMetric(row.heapDelta, 'mb')}</td>
                <td>${formatMetric(row.peakRss, 'mb')}</td>
            </tr>
        `).join('') : '<tr><td colspan="4">No process contribution data for this window.</td></tr>';

        return `
            <div class="bpw-story-evidence-grid">
                <div class="bpw-story-evidence-card">
                    <div class="bpw-story-evidence-label">Memory</div>
                    <strong>${formatMetric(d.totalRssPeak, 'mb')}</strong>
                    <span>Peak total RSS, ${formatMetric(d.totalRssDelta, 'mb')} delta</span>
                </div>
                <div class="bpw-story-evidence-card">
                    <div class="bpw-story-evidence-label">Heap/RSS</div>
                    <strong>${formatMetric(d.ratioPeak, 'ratio')}</strong>
                    <span>Highest ratio in window</span>
                </div>
                <div class="bpw-story-evidence-card">
                    <div class="bpw-story-evidence-label">GC</div>
                    <strong>${formatMetric(d.gcDelta, 'seconds')}</strong>
                    <span>Cumulative delta in window</span>
                </div>
                <div class="bpw-story-evidence-card">
                    <div class="bpw-story-evidence-label">Runtime</div>
                    <strong>${formatMetric(d.jitRatePeak || d.classRatePeak, 'rate')}</strong>
                    <span>Peak JIT/class rate signal</span>
                </div>
            </div>
            <table class="bpw-story-table">
                <thead>
                    <tr>
                        <th>Process</th>
                        <th>RSS delta</th>
                        <th>Heap delta</th>
                        <th>Peak RSS</th>
                    </tr>
                </thead>
                <tbody>${tableRows}</tbody>
            </table>
        `;
    }

    function buildMarkup() {
        return `
            <div class="bpw-story-shell">
                <div class="bpw-story-head">
                    <div>
                        <div class="bpw-studio-kicker">Build story</div>
                        <h2 class="bpw-studio-title">Phase timeline</h2>
                        <p class="bpw-studio-sub">Navigate the run by runtime states, then inspect the metrics behind each phase.</p>
                    </div>
                    <label class="bpw-story-scope">
                        <span>Scope</span>
                        <select id="bpw-story-scope" aria-label="Story chart scope">
                            <option value="phase">Selected phase</option>
                            <option value="cursor">Around cursor</option>
                            <option value="full">Full run</option>
                        </select>
                    </label>
                </div>
                <div class="bpw-story-rail" id="bpw-story-rail" aria-label="Detected build phases"></div>
                <div class="bpw-story-main">
                    <section class="bpw-story-summary" aria-live="polite">
                        <div class="bpw-story-summary-top">
                            <span class="bpw-panel-badge" id="bpw-story-confidence">Phase</span>
                            <strong id="bpw-story-title">Full run</strong>
                            <span id="bpw-story-time">0s</span>
                        </div>
                        <p id="bpw-story-copy"></p>
                        <div class="bpw-story-facts" id="bpw-story-facts"></div>
                        <div class="bpw-story-badges" id="bpw-story-badges"></div>
                    </section>
                    <section class="bpw-story-inspector">
                        <div id="bpw-build-story-chart" class="bpw-story-chart"></div>
                        <div id="bpw-story-evidence" class="bpw-story-evidence"></div>
                    </section>
                </div>
            </div>
        `;
    }

    function renderRail() {
        const rail = document.getElementById('bpw-story-rail');
        if (!rail) return;
        rail.innerHTML = state.phases.map((phase) => {
            const active = phase.id === state.selectedPhaseId;
            const duration = phaseDuration(phase);
            return `
                <button type="button" class="bpw-story-phase bpw-confidence-${phase.confidence}" data-bpw-phase="${phase.id}" aria-pressed="${active ? 'true' : 'false'}">
                    <span>${phase.label}</span>
                    <strong>${phaseTime(phase)}</strong>
                    <small>${phase.dominantMetric} &middot; ${formatSeconds(duration)} &middot; ${phase.confidence}</small>
                </button>
            `;
        }).join('');
        rail.querySelectorAll('[data-bpw-phase]').forEach((button) => {
            button.addEventListener('click', () => {
                const phase = state.phases.find((candidate) => candidate.id === button.getAttribute('data-bpw-phase'));
                if (!phase) return;
                global.BpwExperimentLayout?.pauseUnifiedReplay?.();
                selectPhase(phase.id);
                global.BpwExperimentLayout?.selectUnifiedFrame?.(phase.start);
            });
        });
    }

    function updateCursor(frameIndex) {
        state.cursorFrame = Math.max(0, Math.min(frameIndex, state.timestamps.length - 1));
        const phase = state.phases.find((candidate) => state.cursorFrame >= candidate.start && state.cursorFrame <= candidate.end);
        if (phase && state.selectedPhaseId !== phase.id) {
            state.selectedPhaseId = phase.id;
            if (state.visible) renderSelectedPhase();
        } else {
            const marker = document.getElementById('bpw-story-cursor-marker');
            if (marker) marker.textContent = `Cursor frame ${state.cursorFrame + 1}`;
        }
    }

    function renderSelectedPhase() {
        const phase = state.phases.find((candidate) => candidate.id === state.selectedPhaseId) || state.phases[0];
        if (!phase) return Promise.resolve();
        state.selectedPhaseId = phase.id;
        renderRail();
        const title = document.getElementById('bpw-story-title');
        const time = document.getElementById('bpw-story-time');
        const copy = document.getElementById('bpw-story-copy');
        const confidence = document.getElementById('bpw-story-confidence');
        const facts = document.getElementById('bpw-story-facts');
        const badges = document.getElementById('bpw-story-badges');
        const evidence = document.getElementById('bpw-story-evidence');
        const overlay = defaultOverlayForPhase(phase);
        if (title) title.textContent = phase.label;
        if (time) time.textContent = phaseTime(phase);
        if (copy) {
            const processText = phase.dominantProcess === 'No dominant process'
                ? 'No single process dominated the RSS signal in this window.'
                : `${phase.dominantProcess} contributed the largest RSS signal in this window.`;
            copy.textContent = `${summarySentence(phase)} ${processText}`;
        }
        if (confidence) confidence.textContent = `${phase.confidence} confidence`;
        if (facts) {
            facts.innerHTML = `
                <div><span>Duration</span><strong>${formatSeconds(phaseDuration(phase))}</strong></div>
                <div><span>Samples</span><strong>${phase.sampleCount}</strong></div>
                <div><span>Main metric</span><strong>${phase.dominantMetric}</strong></div>
                <div><span>Overlay</span><strong>${metricLabel(overlay.a)}${overlay.b ? ` + ${metricLabel(overlay.b)}` : ''}</strong></div>
            `;
        }
        if (badges) {
            badges.innerHTML = [
                phase.dominantMetric,
                ...(phase.badges || [])
            ].map((badge) => `<span>${badge}</span>`).join('');
        }
        if (evidence) evidence.innerHTML = renderEvidence(phase);
        return renderFocusChart(phase);
    }

    function bindControls() {
        const scope = document.getElementById('bpw-story-scope');
        if (scope && scope.dataset.bpwStoryBound !== 'true') {
            scope.dataset.bpwStoryBound = 'true';
            scope.value = state.scope;
            scope.addEventListener('change', () => {
                state.scope = ['phase', 'cursor', 'full'].includes(scope.value) ? scope.value : DEFAULT_SCOPE;
                localStorage.setItem(STORAGE_SCOPE_KEY, state.scope);
                renderSelectedPhase();
            });
        }
    }

    function init(options) {
        const { samples, runId, useElapsedAxis, initialFrame } = options || {};
        if (!samples?.length || !shared().buildReplayData) return;

        state.samples = samples;
        state.runId = runId || '';
        state.useElapsedAxis = useElapsedAxis !== false;
        const storedScope = localStorage.getItem(STORAGE_SCOPE_KEY);
        state.scope = ['phase', 'cursor', 'full'].includes(storedScope) ? storedScope : DEFAULT_SCOPE;
        state.cursorFrame = initialFrame ?? 0;
        const rawTimestamps = [...new Set(samples.map((sample) => sample.Timestamp))].sort((a, b) => a - b);
        state.replayData = shared().buildReplayData(samples, rawTimestamps);
        state.timestamps = state.replayData.timestamps || rawTimestamps;
        state.elapsedSeconds = state.timestamps.map((ts) => Math.max(0, (ts - state.timestamps[0]) / 1000));
        state.cursorFrame = Math.min(state.cursorFrame, Math.max(0, state.timestamps.length - 1));
        state.phases = detectPhases();
        state.selectedPhaseId = state.phases.find((phase) => state.cursorFrame >= phase.start && state.cursorFrame <= phase.end)?.id
            || state.phases[0]?.id
            || '';

        const host = document.getElementById('bpw-build-story');
        if (!host) return;
        host.innerHTML = buildMarkup();
        state.bound = true;
        bindControls();
        renderSelectedPhase();

        global.BpwExperimentLayout?.registerReplayPanel?.({
            pause: () => {},
            renderFrame: (frameIndex) => {
                updateCursor(frameIndex);
                return state.visible ? renderSelectedPhase() : Promise.resolve();
            },
            getMaxFrame: () => Math.max(0, state.timestamps.length - 1)
        });
    }

    function selectPhase(phaseId) {
        if (!state.phases.some((phase) => phase.id === phaseId)) return;
        state.selectedPhaseId = phaseId;
        renderSelectedPhase();
    }

    function setScope(scope) {
        state.scope = ['phase', 'cursor', 'full'].includes(scope) ? scope : DEFAULT_SCOPE;
        localStorage.setItem(STORAGE_SCOPE_KEY, state.scope);
        const select = document.getElementById('bpw-story-scope');
        if (select) select.value = state.scope;
        renderSelectedPhase();
    }

    function setVisible(visible) {
        state.visible = Boolean(visible);
        const host = document.getElementById('bpw-build-story');
        if (host) host.hidden = !state.visible;
        if (state.visible && state.bound) renderSelectedPhase();
    }

    function resize() {
        const chart = document.getElementById('bpw-build-story-chart');
        if (chart && typeof Plotly !== 'undefined') {
            Plotly.Plots.resize(chart);
        }
    }

    global.BpwBuildStory = {
        init,
        setVisible,
        selectPhase,
        setScope,
        resize
    };
})(window);
