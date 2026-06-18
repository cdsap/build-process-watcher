(function (global) {
    const STORAGE_KEY = 'bpwLayoutMode';
    const PANEL_STORAGE_KEY = 'bpwPanelVisibility';
    const PRESET_STORAGE_KEY = 'bpwLayoutPreset';
    const MODES = { classic: 'classic', experiment: 'experiment' };

    const PANEL_META = {
        memory: { label: 'Memory', group: 'memory' },
        gc: { label: 'GC time', group: 'memory' },
        ratio: { label: 'Heap/RSS', group: 'memory' },
        'jit-time': { label: 'JIT time', group: 'runtime' },
        'jit-rate': { label: 'JIT rate', group: 'runtime' },
        'classes-loaded': { label: 'Classes loaded', group: 'runtime' },
        'class-rate': { label: 'Class rate', group: 'runtime' }
    };

    const PRESETS = {
        overview: {
            label: 'Overview',
            panels: ['memory', 'gc', 'ratio', 'jit-time', 'jit-rate', 'classes-loaded', 'class-rate']
        },
        memory: {
            label: 'Memory',
            panels: ['memory', 'gc', 'ratio']
        },
        runtime: {
            label: 'Runtime',
            panels: ['jit-time', 'jit-rate', 'classes-loaded', 'class-rate']
        },
        custom: {
            label: 'Custom',
            panels: null
        }
    };

    const replayPanels = [];
    let unifiedTimer = null;
    let unifiedPlaying = false;
    let unifiedFrame = 0;
    let unifiedSpeed = 15;
    let unifiedTimestamps = [];
    let unifiedElapsedByTimestamp = null;
    let focusPanelId = null;

    function getMode() {
        return localStorage.getItem(STORAGE_KEY) === MODES.experiment ? MODES.experiment : MODES.classic;
    }

    function isExperiment() {
        return getMode() === MODES.experiment;
    }

    function setMode(mode) {
        localStorage.setItem(STORAGE_KEY, mode);
        applyMode(mode);
    }

    function toggleMode() {
        setMode(isExperiment() ? MODES.classic : MODES.experiment);
    }

    function getAvailablePanels() {
        return Array.from(document.querySelectorAll('[data-bpw-panel]'))
            .map((el) => el.getAttribute('data-bpw-panel'))
            .filter(Boolean);
    }

    function readPanelVisibility() {
        try {
            const raw = localStorage.getItem(PANEL_STORAGE_KEY);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (_) {
            return null;
        }
    }

    function writePanelVisibility(map) {
        localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify(map));
    }

    function getActivePreset() {
        const stored = localStorage.getItem(PRESET_STORAGE_KEY);
        return stored && PRESETS[stored] ? stored : 'overview';
    }

    function setActivePreset(presetId) {
        localStorage.setItem(PRESET_STORAGE_KEY, presetId);
    }

    function buildVisibilityMap(available, presetId) {
        const preset = PRESETS[presetId];
        const stored = readPanelVisibility();
        const map = {};

        available.forEach((id) => {
            if (presetId === 'custom' && stored && typeof stored[id] === 'boolean') {
                map[id] = stored[id];
            } else if (preset && preset.panels) {
                map[id] = preset.panels.includes(id);
            } else {
                map[id] = true;
            }
        });
        return map;
    }

    function applyPanelVisibility(map) {
        document.querySelectorAll('[data-bpw-panel]').forEach((el) => {
            const id = el.getAttribute('data-bpw-panel');
            const visible = map[id] !== false;
            el.classList.toggle('bpw-panel-hidden', !visible);
        });
        writePanelVisibility(map);
        resizeCharts();
    }

    function applyFocusMode(panelId) {
        focusPanelId = panelId || null;
        document.body.classList.toggle('bpw-focus-mode', Boolean(panelId));
        document.querySelectorAll('[data-bpw-panel]').forEach((el) => {
            const id = el.getAttribute('data-bpw-panel');
            el.classList.toggle('bpw-panel-focus-active', panelId === id);
        });
        document.querySelectorAll('.bpw-panel-focus-btn').forEach((btn) => {
            const target = btn.getAttribute('data-bpw-focus');
            btn.setAttribute('aria-pressed', target === panelId ? 'true' : 'false');
            btn.textContent = target === panelId ? 'Exit focus' : 'Focus';
        });
        resizeCharts();
    }

    function initWorkspaceDeck() {
        const deck = document.getElementById('bpw-workspace-deck');
        if (!deck) return;

        const available = getAvailablePanels();
        if (!available.length) {
            deck.innerHTML = '';
            return;
        }

        const presetId = getActivePreset();
        const visibility = buildVisibilityMap(available, presetId);

        deck.innerHTML = `
            <div class="bpw-deck-row">
                <span class="bpw-deck-label">Layout</span>
                <div class="bpw-deck-presets">
                    ${Object.entries(PRESETS).map(([id, preset]) => `
                        <button type="button" class="bpw-preset-btn" data-bpw-preset="${id}" aria-pressed="${id === presetId ? 'true' : 'false'}">${preset.label}</button>
                    `).join('')}
                </div>
            </div>
            <div class="bpw-deck-row">
                <span class="bpw-deck-label">Panels</span>
                <div class="bpw-deck-toggles" id="bpw-deck-toggles"></div>
            </div>
            <div class="bpw-deck-hint">Pick a layout preset or toggle panels to build your own mosaic. Use <strong>Focus</strong> on a card to expand it full width.</div>
        `;

        const toggles = deck.querySelector('#bpw-deck-toggles');
        available.forEach((id) => {
            const meta = PANEL_META[id] || { label: id };
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'bpw-panel-chip';
            chip.setAttribute('data-bpw-panel-toggle', id);
            chip.setAttribute('aria-pressed', visibility[id] ? 'true' : 'false');
            chip.innerHTML = `<span class="bpw-chip-dot"></span>${meta.label}`;
            toggles.appendChild(chip);
        });

        deck.querySelectorAll('[data-bpw-preset]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const id = btn.getAttribute('data-bpw-preset');
                setActivePreset(id);
                deck.querySelectorAll('[data-bpw-preset]').forEach((b) => {
                    b.setAttribute('aria-pressed', b.getAttribute('data-bpw-preset') === id ? 'true' : 'false');
                });
                const nextVisibility = buildVisibilityMap(getAvailablePanels(), id);
                applyPanelVisibility(nextVisibility);
                toggles.querySelectorAll('[data-bpw-panel-toggle]').forEach((chip) => {
                    const panelId = chip.getAttribute('data-bpw-panel-toggle');
                    chip.setAttribute('aria-pressed', nextVisibility[panelId] ? 'true' : 'false');
                });
                if (id !== 'custom') {
                    applyFocusMode(null);
                }
            });
        });

        toggles.querySelectorAll('[data-bpw-panel-toggle]').forEach((chip) => {
            chip.addEventListener('click', () => {
                setActivePreset('custom');
                deck.querySelectorAll('[data-bpw-preset]').forEach((b) => {
                    b.setAttribute('aria-pressed', b.getAttribute('data-bpw-preset') === 'custom' ? 'true' : 'false');
                });
                const panelId = chip.getAttribute('data-bpw-panel-toggle');
                const next = { ...readPanelVisibility(), ...buildVisibilityMap(getAvailablePanels(), 'custom') };
                next[panelId] = chip.getAttribute('aria-pressed') !== 'true';
                chip.setAttribute('aria-pressed', next[panelId] ? 'true' : 'false');
                applyPanelVisibility(next);
            });
        });

        applyPanelVisibility(visibility);
        initPanelFocusButtons();
    }

    function initPanelFocusButtons() {
        document.querySelectorAll('.bpw-panel-focus-btn').forEach((btn) => {
            if (btn.dataset.bpwFocusBound === 'true') return;
            btn.dataset.bpwFocusBound = 'true';
            btn.addEventListener('click', () => {
                const target = btn.getAttribute('data-bpw-focus');
                if (focusPanelId === target) {
                    applyFocusMode(null);
                } else {
                    applyFocusMode(target);
                }
            });
        });
    }

    function updateToggleButtons() {
        const experimentActive = isExperiment();
        document.querySelectorAll('[data-bpw-layout-toggle]').forEach((btn) => {
            btn.textContent = experimentActive ? 'Classic layout' : 'Experiment layout';
            btn.setAttribute('aria-pressed', experimentActive ? 'true' : 'false');
            btn.title = experimentActive
                ? 'Switch back to the classic stacked chart layout'
                : 'Try the workspace mosaic with combinable panels';
        });
    }

    function compactChartLegends() {
        if (!isExperiment() || typeof Plotly === 'undefined') return;
        document.querySelectorAll('.js-plotly-plot').forEach((el) => {
            try {
                Plotly.relayout(el, {
                    showlegend: true,
                    legend: {
                        orientation: 'h',
                        x: 0,
                        y: -0.22,
                        xanchor: 'left',
                        yanchor: 'top'
                    },
                    margin: { r: 24, t: 28, b: 88 }
                });
            } catch (_) {
                /* ignore */
            }
        });
    }

    function resizeCharts() {
        if (typeof Plotly === 'undefined') return;
        setTimeout(() => {
            document.querySelectorAll('.js-plotly-plot').forEach((el) => {
                try {
                    Plotly.Plots.resize(el);
                } catch (_) {
                    /* ignore */
                }
            });
            if (isExperiment()) {
                compactChartLegends();
            }
        }, 180);
    }

    function applyMode(mode) {
        const experiment = mode === MODES.experiment;
        document.body.classList.toggle('bpw-layout-experiment', experiment);
        document.body.classList.toggle('bpw-layout-classic', !experiment);

        const deck = document.getElementById('bpw-workspace-deck');
        const unified = document.getElementById('bpw-unified-replay');
        if (deck) deck.hidden = !experiment;
        if (unified) unified.hidden = !experiment;

        updateToggleButtons();

        if (experiment) {
            initWorkspaceDeck();
            compactChartLegends();
        } else {
            applyFocusMode(null);
            document.querySelectorAll('[data-bpw-panel]').forEach((el) => {
                el.classList.remove('bpw-panel-hidden', 'bpw-panel-focus-active');
            });
        }

        resizeCharts();

        if (!experiment) {
            pauseUnifiedReplay();
        }
    }

    function clearReplayPanels() {
        replayPanels.length = 0;
        pauseUnifiedReplay();
    }

    function registerReplayPanel(panel) {
        if (!panel || typeof panel.renderFrame !== 'function') return;
        replayPanels.push(panel);
    }

    function pauseUnifiedReplay() {
        unifiedPlaying = false;
        if (unifiedTimer) {
            clearTimeout(unifiedTimer);
            unifiedTimer = null;
        }
        replayPanels.forEach((panel) => {
            if (panel.pause) panel.pause();
        });
    }

    function getMaxFrame() {
        if (unifiedTimestamps.length) return unifiedTimestamps.length - 1;
        return replayPanels.reduce((max, panel) => {
            const panelMax = typeof panel.getMaxFrame === 'function' ? panel.getMaxFrame() : 0;
            return Math.max(max, panelMax);
        }, 0);
    }

    function updateUnifiedUi(frameIndex) {
        const timeline = document.getElementById('bpw-unified-timeline');
        const meta = document.getElementById('bpw-unified-meta');
        const timeLabel = document.getElementById('bpw-unified-time-label');
        const maxFrame = getMaxFrame();

        if (timeline) {
            timeline.max = String(Math.max(0, maxFrame));
            timeline.value = String(frameIndex);
        }
        if (meta) {
            meta.textContent = `Frame ${frameIndex + 1} / ${maxFrame + 1}`;
        }
        if (timeLabel && unifiedTimestamps.length && unifiedElapsedByTimestamp) {
            const timestamp = unifiedTimestamps[frameIndex];
            const elapsed = unifiedElapsedByTimestamp.get(timestamp);
            const timeText = timestamp ? new Date(timestamp).toLocaleTimeString() : '';
            timeLabel.textContent = elapsed !== undefined
                ? `Elapsed: ${elapsed}s | ${timeText}`
                : `Elapsed: ${frameIndex}s`;
        }
    }

    function renderUnifiedFrame(frameIndex) {
        unifiedFrame = frameIndex;
        updateUnifiedUi(frameIndex);
        const tasks = replayPanels.map((panel) => panel.renderFrame(frameIndex));
        return Promise.all(tasks);
    }

    function scheduleUnifiedNext() {
        if (!unifiedPlaying || !isExperiment()) return;
        const maxFrame = getMaxFrame();
        if (unifiedFrame >= maxFrame) {
            unifiedPlaying = false;
            return;
        }
        const nextDelay = unifiedTimestamps.length > 1
            ? Math.max(
                16,
                (unifiedTimestamps[unifiedFrame + 1] - unifiedTimestamps[unifiedFrame]) / unifiedSpeed
            )
            : 120;
        unifiedTimer = setTimeout(() => {
            renderUnifiedFrame(unifiedFrame + 1).then(scheduleUnifiedNext);
        }, nextDelay);
    }

    function playUnifiedReplay() {
        if (!isExperiment() || !replayPanels.length) return;
        if (unifiedPlaying) return;
        unifiedPlaying = true;
        replayPanels.forEach((panel) => {
            if (panel.pause) panel.pause();
        });
        scheduleUnifiedNext();
    }

    function initUnifiedReplay(options) {
        const { timestamps, elapsedByTimestamp } = options || {};
        unifiedTimestamps = timestamps || [];
        unifiedElapsedByTimestamp = elapsedByTimestamp || null;

        const container = document.getElementById('bpw-unified-replay');
        if (!container) return;

        const playBtn = document.getElementById('bpw-unified-play');
        const pauseBtn = document.getElementById('bpw-unified-pause');
        const resetBtn = document.getElementById('bpw-unified-reset');
        const timeline = document.getElementById('bpw-unified-timeline');
        const speedSelect = document.getElementById('bpw-unified-speed');

        if (!playBtn || !pauseBtn || !resetBtn || !timeline) return;

        if (container.dataset.bpwUnifiedBound === 'true') {
            const initialFrame = Math.max(0, getMaxFrame());
            renderUnifiedFrame(initialFrame);
            return;
        }
        container.dataset.bpwUnifiedBound = 'true';

        unifiedSpeed = Number(speedSelect?.value) || 15;

        playBtn.addEventListener('click', playUnifiedReplay);
        pauseBtn.addEventListener('click', pauseUnifiedReplay);
        resetBtn.addEventListener('click', () => {
            pauseUnifiedReplay();
            renderUnifiedFrame(0);
        });
        timeline.addEventListener('input', () => {
            pauseUnifiedReplay();
            renderUnifiedFrame(Number(timeline.value));
        });
        if (speedSelect) {
            speedSelect.addEventListener('change', () => {
                const parsed = Number(speedSelect.value);
                if (!Number.isNaN(parsed) && parsed > 0) unifiedSpeed = parsed;
            });
        }

        const initialFrame = Math.max(0, getMaxFrame());
        renderUnifiedFrame(initialFrame);
    }

    function initToggleButtons() {
        document.querySelectorAll('[data-bpw-layout-toggle]').forEach((btn) => {
            if (btn.dataset.bpwToggleBound === 'true') return;
            btn.dataset.bpwToggleBound = 'true';
            btn.addEventListener('click', toggleMode);
        });
        updateToggleButtons();
    }

    function bootstrap() {
        applyMode(getMode());
        initToggleButtons();
    }

    global.BpwExperimentLayout = {
        MODES,
        getMode,
        setMode,
        toggleMode,
        applyMode,
        isExperiment,
        clearReplayPanels,
        registerReplayPanel,
        initUnifiedReplay,
        initToggleButtons,
        initWorkspaceDeck,
        initPanelFocusButtons,
        resizeCharts
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap);
    } else {
        bootstrap();
    }
})(window);
