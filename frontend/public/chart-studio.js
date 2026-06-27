(function (global) {
    const LAYER_STORAGE_KEY = 'bpwStudioLayers';
    const PRESET_STORAGE_KEY = 'bpwStudioPreset';

    let state = {
        samples: [],
        runId: '',
        replayData: null,
        timestamps: [],
        elapsedSeconds: [],
        frameIndex: 0,
        metricA: 'rss',
        metricB: 'gc',
        useElapsedAxis: true,
        bound: false
    };

    function readLayers() {
        try {
            const raw = localStorage.getItem(LAYER_STORAGE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (_) {
            return null;
        }
    }

    function writeLayers(metricA, metricB) {
        localStorage.setItem(LAYER_STORAGE_KEY, JSON.stringify({ a: metricA, b: metricB }));
    }

    function getShared() {
        return global.BpwCompareShared || {};
    }

    function getAvailableMetrics() {
        const shared = getShared();
        return shared.getAvailableOverlayMetrics?.(state.samples) || ['rss'];
    }

    function restoreLayers() {
        const available = getAvailableMetrics();
        const stored = readLayers();
        const presetId = localStorage.getItem(PRESET_STORAGE_KEY);
        const presets = getShared().OVERLAY_PRESETS || {};

        if (presetId && presets[presetId]) {
            const preset = presets[presetId];
            if (available.includes(preset.a)) state.metricA = preset.a;
            if (preset.b && available.includes(preset.b)) state.metricB = preset.b;
        } else if (stored) {
            if (stored.a && available.includes(stored.a)) state.metricA = stored.a;
            if (stored.b && available.includes(stored.b)) state.metricB = stored.b;
        }

        if (!available.includes(state.metricA)) state.metricA = available[0];
        if (!available.includes(state.metricB)) {
            state.metricB = available.find((m) => m !== state.metricA) || '';
        }
    }

    function buildStudioMarkup(available) {
        const shared = getShared();
        const catalog = shared.METRIC_CATALOG || {};
        const presets = shared.OVERLAY_PRESETS || {};
        const presetId = localStorage.getItem(PRESET_STORAGE_KEY) || 'memory-gc';

        const optionHtml = (metrics, selected) => metrics.map((id) => {
            const meta = catalog[id] || { label: id };
            return `<option value="${id}" ${id === selected ? 'selected' : ''}>${meta.label}</option>`;
        }).join('');

        const presetButtons = Object.entries(presets)
            .filter(([, preset]) => available.includes(preset.a) && (preset.b === undefined || available.includes(preset.b)))
            .map(([id, preset]) => `
                <button type="button" class="bpw-studio-preset" data-bpw-studio-preset="${id}" aria-pressed="${id === presetId ? 'true' : 'false'}">${preset.label}</button>
            `).join('');

        return `
            <div class="bpw-studio-shell">
                <div class="bpw-studio-header">
                    <div>
                        <div class="bpw-studio-kicker">Chart studio</div>
                        <h2 class="bpw-studio-title">Overlay composer</h2>
                        <p class="bpw-studio-sub">Superpose two metric families on one timeline with independent Y axes.</p>
                    </div>
                    <div class="bpw-studio-layers">
                        <label class="bpw-studio-layer">
                            <span class="bpw-studio-layer-tag bpw-layer-a">Layer A</span>
                            <select id="bpw-studio-layer-a" aria-label="Layer A metric">${optionHtml(available, state.metricA)}</select>
                        </label>
                        <label class="bpw-studio-layer">
                            <span class="bpw-studio-layer-tag bpw-layer-b">Layer B</span>
                            <select id="bpw-studio-layer-b" aria-label="Layer B metric">
                                <option value="">— none —</option>
                                ${optionHtml(available, state.metricB)}
                            </select>
                        </label>
                    </div>
                </div>
                <div class="bpw-studio-presets" aria-label="Overlay presets">${presetButtons}</div>
                <div class="bpw-studio-canvas">
                    <div id="bpw-studio-chart" class="bpw-studio-chart"></div>
                </div>
            </div>
        `;
    }

    function ensureStudioMounted(host) {
        if (!host) return false;
        if (document.getElementById('bpw-studio-chart')) return true;

        host.innerHTML = buildStudioMarkup(getAvailableMetrics());
        bindStudioControls();
        state.bound = true;
        return Boolean(document.getElementById('bpw-studio-chart'));
    }

    function renderStudio() {
        const host = document.getElementById('bpw-chart-studio');
        if (!host || host.hidden) return Promise.resolve();
        if (!ensureStudioMounted(host)) return Promise.resolve();

        const shared = getShared();
        if (!shared.buildOverlayTraces || !state.replayData) return Promise.resolve();
        if (typeof Plotly === 'undefined') return Promise.resolve();

        const xValues = state.useElapsedAxis ? state.elapsedSeconds : null;
        const traces = shared.applyVisibilityToTraces(
            'bpw-studio-chart',
            shared.buildOverlayTraces(
                state.replayData,
                state.timestamps,
                state.frameIndex,
                state.metricA,
                state.metricB || null,
                xValues
            )
        );

        const layout = shared.getOverlayLayout(state.metricA, state.metricB || null);
        if (state.useElapsedAxis) {
            layout.xaxis = {
                ...layout.xaxis,
                title: 'Elapsed (s)',
                tickformat: null,
                type: 'linear'
            };
        }

        const catalog = shared.METRIC_CATALOG || {};
        const labelA = catalog[state.metricA]?.label || state.metricA;
        const labelB = state.metricB ? (catalog[state.metricB]?.label || state.metricB) : '';
        layout.title = labelB ? `${labelA} × ${labelB}` : labelA;

        return Plotly.react(
            'bpw-studio-chart',
            traces,
            layout,
            shared.getOverlayConfig(`bpw-studio-${state.runId}`)
        ).then(() => {
            shared.attachLegendVisibilityHandlers?.('bpw-studio-chart');
        });
    }

    function applyPreset(presetId) {
        const shared = getShared();
        const preset = shared.OVERLAY_PRESETS?.[presetId];
        if (!preset) return;

        const available = getAvailableMetrics();
        if (!available.includes(preset.a)) return;

        state.metricA = preset.a;
        state.metricB = preset.b && available.includes(preset.b) ? preset.b : '';
        localStorage.setItem(PRESET_STORAGE_KEY, presetId);
        writeLayers(state.metricA, state.metricB);

        const selectA = document.getElementById('bpw-studio-layer-a');
        const selectB = document.getElementById('bpw-studio-layer-b');
        if (selectA) selectA.value = state.metricA;
        if (selectB) selectB.value = state.metricB || '';

        document.querySelectorAll('[data-bpw-studio-preset]').forEach((btn) => {
            btn.setAttribute('aria-pressed', btn.getAttribute('data-bpw-studio-preset') === presetId ? 'true' : 'false');
        });

        renderStudio();
    }

    function bindStudioControls() {
        const selectA = document.getElementById('bpw-studio-layer-a');
        const selectB = document.getElementById('bpw-studio-layer-b');
        if (!selectA || !selectB) return;

        selectA.addEventListener('change', () => {
            state.metricA = selectA.value;
            if (state.metricB === state.metricA) {
                const alt = getAvailableMetrics().find((m) => m !== state.metricA);
                state.metricB = alt || '';
                selectB.value = state.metricB;
            }
            localStorage.setItem(PRESET_STORAGE_KEY, 'custom');
            writeLayers(state.metricA, state.metricB);
            document.querySelectorAll('[data-bpw-studio-preset]').forEach((btn) => btn.setAttribute('aria-pressed', 'false'));
            renderStudio();
        });

        selectB.addEventListener('change', () => {
            state.metricB = selectB.value;
            localStorage.setItem(PRESET_STORAGE_KEY, 'custom');
            writeLayers(state.metricA, state.metricB);
            document.querySelectorAll('[data-bpw-studio-preset]').forEach((btn) => btn.setAttribute('aria-pressed', 'false'));
            renderStudio();
        });

        document.querySelectorAll('[data-bpw-studio-preset]').forEach((btn) => {
            btn.addEventListener('click', () => {
                applyPreset(btn.getAttribute('data-bpw-studio-preset'));
            });
        });
    }

    function registerReplayPanel() {
        if (!global.BpwExperimentLayout) return;
        global.BpwExperimentLayout.registerReplayPanel({
            pause: () => {},
            renderFrame: (frameIndex) => {
                state.frameIndex = frameIndex;
                return renderStudio();
            },
            getMaxFrame: () => Math.max(0, state.timestamps.length - 1)
        });
    }

    function init(options) {
        const shared = getShared();
        const { samples, runId, useElapsedAxis, initialFrame } = options || {};
        if (!samples?.length || !shared.buildReplayData) return;

        state.samples = samples;
        state.runId = runId || '';
        state.useElapsedAxis = useElapsedAxis !== false;

        const rawTimestamps = [...new Set(samples.map((s) => s.Timestamp))].sort((a, b) => a - b);
        state.replayData = shared.buildReplayData(samples, rawTimestamps);
        state.timestamps = state.replayData.timestamps || rawTimestamps;
        state.elapsedSeconds = state.timestamps.map((ts) => Math.max(0, (ts - state.timestamps[0]) / 1000));
        state.frameIndex = initialFrame ?? Math.max(0, state.timestamps.length - 1);

        restoreLayers();

        const host = document.getElementById('bpw-chart-studio');
        if (!host) return;

        if (!state.bound) {
            ensureStudioMounted(host);
        } else {
            ensureStudioMounted(host);
            const selectA = document.getElementById('bpw-studio-layer-a');
            const selectB = document.getElementById('bpw-studio-layer-b');
            if (selectA) selectA.value = state.metricA;
            if (selectB) selectB.value = state.metricB || '';
        }

        registerReplayPanel();
        return renderStudio();
    }

    function setVisible(visible) {
        const host = document.getElementById('bpw-chart-studio');
        if (!host) return;
        host.hidden = !visible;
        if (visible && state.bound) {
            renderStudio();
        }
    }

    function resize() {
        if (typeof Plotly === 'undefined') return;
        const el = document.getElementById('bpw-studio-chart');
        if (el) Plotly.Plots.resize(el);
    }

    global.BpwChartStudio = {
        init,
        renderStudio,
        setVisible,
        resize,
        applyPreset
    };
})(window);
