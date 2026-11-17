(function (global) {
    const STORAGE_KEY = 'bpwLayoutMode';
    const PANEL_STORAGE_KEY = 'bpwPanelVisibility';
    const PRESET_STORAGE_KEY = 'bpwLayoutPreset';
    const PERSPECTIVE_STORAGE_KEY = 'bpwExperimentPerspective';
    const VIEW_STORAGE_KEY = 'bpwViewMode';
    const MODES = { classic: 'classic', experiment: 'experiment' };
    const PERSPECTIVES = { studio: 'studio', story: 'story' };
    const VIEW_MODES = { classic: 'classic', studio: 'studio', story: 'story', predictions: 'predictions' };

    const PANEL_META = {
        memory: { label: 'Memory', group: 'memory' },
        gc: { label: 'GC time', group: 'memory' },
        'jit-time': { label: 'JIT time', group: 'runtime' },
        'jit-rate': { label: 'JIT rate', group: 'runtime' },
        'classes-loaded': { label: 'Classes loaded', group: 'runtime' },
        'class-rate': { label: 'Class rate', group: 'runtime' }
    };

    const PRESETS = {
        overview: {
            label: 'Overview',
            panels: ['memory', 'gc', 'jit-time', 'jit-rate', 'classes-loaded', 'class-rate']
        },
        memory: {
            label: 'Memory',
            panels: ['memory', 'gc']
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
    let unifiedClock = null;
    let unifiedPlaybackTimestamps = [];
    let unifiedFrame = 0;
    let unifiedRenderPromise = Promise.resolve([]);
    let unifiedTimestamps = [];
    let unifiedElapsedByTimestamp = null;
    let focusPanelId = null;
    let predictionsEnabled = false;

    function getMode() {
        return localStorage.getItem(STORAGE_KEY) === MODES.experiment ? MODES.experiment : MODES.classic;
    }

    function isExperiment() {
        return getMode() === MODES.experiment;
    }

    function getPerspective() {
        return localStorage.getItem(PERSPECTIVE_STORAGE_KEY) === PERSPECTIVES.story
            ? PERSPECTIVES.story
            : PERSPECTIVES.studio;
    }

    function setPerspective(perspective) {
        const next = perspective === PERSPECTIVES.story ? PERSPECTIVES.story : PERSPECTIVES.studio;
        localStorage.setItem(PERSPECTIVE_STORAGE_KEY, next);
        applyPerspective(next);
    }

    function isStoryPerspective() {
        return isExperiment() && getPerspective() === PERSPECTIVES.story;
    }

    function supportsStoryMode() {
        return Boolean(global.BpwBuildStory);
    }

    function getViewMode() {
        if (localStorage.getItem(VIEW_STORAGE_KEY) === VIEW_MODES.predictions) {
            if (supportsPredictionsMode()) return VIEW_MODES.predictions;
            localStorage.removeItem(VIEW_STORAGE_KEY);
        }
        if (!isExperiment()) return VIEW_MODES.classic;
        return getPerspective() === PERSPECTIVES.story ? VIEW_MODES.story : VIEW_MODES.studio;
    }

    function hasPredictionsPanel() {
        return Boolean(document.getElementById('run-panel-predictions'));
    }

    function supportsPredictionsMode() {
        return hasPredictionsPanel() && predictionsEnabled === true;
    }

    function setPredictionsEnabled(enabled) {
        predictionsEnabled = enabled === true;
        if (!predictionsEnabled && getViewMode() === VIEW_MODES.predictions) {
            localStorage.removeItem(VIEW_STORAGE_KEY);
            applyMode(getMode());
        }
        document.querySelectorAll('.bpw-mode-switch').forEach((switcher) => {
            refreshPredictionsModeButton(switcher);
        });
        updateModeSwitches();
    }

    function isPredictionsEnabled() {
        return predictionsEnabled === true;
    }

    function setDashboardPanelsVisible(showDashboard) {
        const dashboardPanel = document.getElementById('run-panel-dashboard');
        const predictionsPanel = document.getElementById('run-panel-predictions');
        if (dashboardPanel) dashboardPanel.hidden = !showDashboard;
        if (predictionsPanel) predictionsPanel.hidden = showDashboard;
    }

    function applyPredictionsView() {
        document.body.classList.add('bpw-view-predictions');
        document.body.classList.remove(
            'bpw-layout-experiment',
            'bpw-layout-classic',
            'bpw-perspective-story',
            'bpw-perspective-studio',
        );
        const deck = document.getElementById('bpw-workspace-deck');
        const unified = document.getElementById('bpw-unified-replay');
        if (deck) deck.hidden = true;
        if (unified) unified.hidden = true;
        if (global.BpwChartStudio) global.BpwChartStudio.setVisible(false);
        if (global.BpwBuildStory) global.BpwBuildStory.setVisible(false);
        setDashboardPanelsVisible(false);
        updateToggleButtons();
        updateModeSwitches();
        pauseUnifiedReplay();
    }

    function clearPredictionsViewClass() {
        document.body.classList.remove('bpw-view-predictions');
    }

    function setViewMode(viewMode) {
        if (viewMode === VIEW_MODES.predictions) {
            if (!supportsPredictionsMode()) return;
            localStorage.setItem(VIEW_STORAGE_KEY, VIEW_MODES.predictions);
            applyPredictionsView();
            return;
        }
        localStorage.removeItem(VIEW_STORAGE_KEY);
        if (viewMode === VIEW_MODES.classic) {
            localStorage.setItem(STORAGE_KEY, MODES.classic);
            applyMode(MODES.classic);
            return;
        }
        localStorage.setItem(STORAGE_KEY, MODES.experiment);
        localStorage.setItem(
            PERSPECTIVE_STORAGE_KEY,
            viewMode === VIEW_MODES.story && supportsStoryMode() ? PERSPECTIVES.story : PERSPECTIVES.studio
        );
        applyMode(MODES.experiment);
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
            btn.textContent = target === panelId ? 'Collapse' : 'Expand';
            btn.title = target === panelId ? 'Return to the full chart grid' : 'Expand this panel';
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
            <div class="bpw-studio-controls" data-bpw-studio-controls>
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
            </div>
            <div class="bpw-deck-hint" data-bpw-deck-hint>Use <strong>Chart studio</strong> above to overlay metrics (e.g. Memory + GC). Toggle runtime panels below or use studio presets for JIT/classes.</div>
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
        applyPerspective(getPerspective());
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
            if (global.BpwChartStudio) {
                global.BpwChartStudio.resize();
            }
            if (global.BpwBuildStory) {
                global.BpwBuildStory.resize();
            }
            if (isExperiment()) {
                compactChartLegends();
            }
        }, 180);
    }

    function applyPerspective(perspective) {
        const story = isExperiment() && perspective === PERSPECTIVES.story;
        document.body.classList.toggle('bpw-perspective-story', story);
        document.body.classList.toggle('bpw-perspective-studio', isExperiment() && !story);

        document.querySelectorAll('[data-bpw-perspective]').forEach((btn) => {
            btn.setAttribute('aria-pressed', btn.getAttribute('data-bpw-perspective') === (story ? PERSPECTIVES.story : PERSPECTIVES.studio) ? 'true' : 'false');
        });
        updateModeSwitches();

        if (global.BpwChartStudio) {
            global.BpwChartStudio.setVisible(isExperiment() && !story);
        }
        if (global.BpwBuildStory) {
            global.BpwBuildStory.setVisible(story);
        }

        const hint = document.querySelector('[data-bpw-deck-hint]');
        if (hint) {
            hint.innerHTML = story
                ? 'Use <strong>Build story</strong> to inspect detected phases, then switch back to Studio for manual overlays.'
                : 'Use <strong>Chart studio</strong> above to overlay metrics (e.g. Memory + GC). Toggle runtime panels below or use studio presets for JIT/classes.';
        }
        resizeCharts();
    }

    function buildModeButton(mode, label, description) {
        return `
            <button type="button" class="bpw-mode-btn" data-bpw-view-mode="${mode}" aria-pressed="${getViewMode() === mode ? 'true' : 'false'}">
                <span>${label}</span>
                <small>${description}</small>
            </button>
        `;
    }

    function predictionsModeButtonHtml() {
        if (!hasPredictionsPanel()) return '';
        const enabled = supportsPredictionsMode();
        const pressed = getViewMode() === VIEW_MODES.predictions;
        return `
            <button type="button" class="bpw-mode-btn" data-bpw-view-mode="${VIEW_MODES.predictions}" aria-pressed="${pressed ? 'true' : 'false'}" aria-disabled="${enabled ? 'false' : 'true'}" ${enabled ? '' : 'disabled'}>
                <span>Predictions</span>
                <small>${enabled ? 'Forecasts + checkpoints' : 'Not enabled'}</small>
            </button>
        `;
    }

    function refreshPredictionsModeButton(switcher) {
        if (!switcher) return;
        const existing = switcher.querySelector('[data-bpw-view-mode="predictions"]');
        if (!hasPredictionsPanel()) {
            if (existing) existing.remove();
            return;
        }
        const html = predictionsModeButtonHtml();
        if (existing) {
            existing.outerHTML = html;
        } else {
            switcher.insertAdjacentHTML('beforeend', html);
        }
        const button = switcher.querySelector('[data-bpw-view-mode="predictions"]');
        if (!button) return;
        button.dataset.bpwModeBound = 'true';
        button.addEventListener('click', () => {
            if (button.disabled || button.getAttribute('aria-disabled') === 'true') return;
            setViewMode(VIEW_MODES.predictions);
        });
    }

    function modeSwitchMarkup() {
        const experimentLabel = supportsStoryMode() ? 'Studio' : 'Experiment';
        const experimentDescription = supportsStoryMode() ? 'Overlay + panels' : 'Alternate layout';
        return [
            buildModeButton(VIEW_MODES.classic, 'Classic', 'Stacked charts'),
            buildModeButton(VIEW_MODES.studio, experimentLabel, experimentDescription),
            supportsStoryMode() ? buildModeButton(VIEW_MODES.story, 'Story', 'Detected phases') : '',
            predictionsModeButtonHtml()
        ].join('');
    }

    function bindModeSwitch(switcher) {
        if (!switcher) return;
        switcher.querySelectorAll('[data-bpw-view-mode]').forEach((btn) => {
            if (btn.dataset.bpwModeBound === 'true') return;
            btn.dataset.bpwModeBound = 'true';
            btn.addEventListener('click', () => {
                if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return;
                setViewMode(btn.getAttribute('data-bpw-view-mode'));
            });
        });
    }

    function ensureModeSwitch(toggleButton) {
        if (!toggleButton) return;
        const existing = toggleButton.nextElementSibling;
        if (toggleButton.dataset.bpwModeSwitchReady === 'true' && existing?.classList?.contains('bpw-mode-switch')) {
            // Run HTML mounts after first paint; add Predictions once the panel exists.
            refreshPredictionsModeButton(existing);
            bindModeSwitch(existing);
            updateModeSwitches();
            return;
        }
        toggleButton.dataset.bpwModeSwitchReady = 'true';
        toggleButton.classList.add('bpw-toggle-replaced');
        toggleButton.setAttribute('aria-hidden', 'true');
        toggleButton.tabIndex = -1;

        const switcher = document.createElement('div');
        switcher.className = 'bpw-mode-switch';
        switcher.setAttribute('role', 'group');
        switcher.setAttribute('aria-label', 'Dashboard view mode');
        switcher.innerHTML = modeSwitchMarkup();
        bindModeSwitch(switcher);
        toggleButton.insertAdjacentElement('afterend', switcher);
    }

    function updateModeSwitches() {
        const viewMode = getViewMode();
        document.querySelectorAll('[data-bpw-view-mode]').forEach((btn) => {
            btn.setAttribute('aria-pressed', btn.getAttribute('data-bpw-view-mode') === viewMode ? 'true' : 'false');
        });
    }

    function applyMode(mode) {
        if (localStorage.getItem(VIEW_STORAGE_KEY) === VIEW_MODES.predictions && supportsPredictionsMode()) {
            applyPredictionsView();
            return;
        }
        clearPredictionsViewClass();
        setDashboardPanelsVisible(true);

        const experiment = mode === MODES.experiment;
        document.body.classList.toggle('bpw-layout-experiment', experiment);
        document.body.classList.toggle('bpw-layout-classic', !experiment);
        if (!experiment) {
            document.body.classList.remove('bpw-perspective-story', 'bpw-perspective-studio');
        }

        const deck = document.getElementById('bpw-workspace-deck');
        const unified = document.getElementById('bpw-unified-replay');
        if (deck) deck.hidden = !experiment;
        if (unified) unified.hidden = !experiment;
        applyPerspective(experiment ? getPerspective() : PERSPECTIVES.studio);

        updateToggleButtons();
        updateModeSwitches();

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
        if (unifiedClock) unifiedClock.pause();
        replayPanels.forEach((panel) => {
            if (panel.pause) panel.pause();
        });
    }

    function selectUnifiedFrame(frameIndex) {
        pauseUnifiedReplay();
        const maxFrame = getMaxFrame();
        const nextFrame = Math.max(0, Math.min(Number(frameIndex) || 0, maxFrame));
        if (!unifiedClock || !unifiedPlaybackTimestamps.length) {
            return renderUnifiedFrame(nextFrame);
        }
        unifiedClock.seekTo(
            unifiedPlaybackTimestamps[nextFrame] - unifiedPlaybackTimestamps[0]
        );
        return unifiedRenderPromise;
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
        unifiedRenderPromise = Promise.all(tasks);
        return unifiedRenderPromise;
    }

    function createUnifiedClock(speed) {
        if (unifiedClock) unifiedClock.destroy();
        unifiedClock = null;

        const maxFrame = getMaxFrame();
        unifiedPlaybackTimestamps = unifiedTimestamps.length
            ? unifiedTimestamps.slice()
            : Array.from({ length: maxFrame + 1 }, (_, index) => index * 1800);

        if (!global.BpwPlaybackClock || !unifiedPlaybackTimestamps.length) return;
        unifiedClock = global.BpwPlaybackClock.createPlaybackClock({
            timestamps: unifiedPlaybackTimestamps,
            speed,
            onPosition: (position) => {
                if (position.sampleIndex >= 0 && position.sampleIndex !== unifiedFrame) {
                    renderUnifiedFrame(position.sampleIndex);
                }
            }
        });
    }

    function playUnifiedReplay() {
        if (!isExperiment() || !replayPanels.length || !unifiedClock) return;
        replayPanels.forEach((panel) => {
            if (panel.pause) panel.pause();
        });
        unifiedClock.play();
    }

    function initUnifiedReplay(options) {
        const { timestamps, elapsedByTimestamp } = options || {};
        unifiedTimestamps = timestamps || [];
        unifiedElapsedByTimestamp = elapsedByTimestamp || null;

        const container = document.getElementById('bpw-unified-replay');
        if (!container) return;

        const playBtn = document.getElementById('btn-bpw-unified-play');
        const pauseBtn = document.getElementById('btn-bpw-unified-pause');
        const resetBtn = document.getElementById('btn-bpw-unified-reset');
        const timeline = document.getElementById('bpw-unified-timeline');
        const speedSelect = document.getElementById('bpw-unified-speed');

        if (!playBtn || !pauseBtn || !resetBtn || !timeline) return;

        const initialFrame = Math.max(0, getMaxFrame());
        createUnifiedClock(Number(speedSelect?.value) || 15);
        if (unifiedClock && unifiedPlaybackTimestamps.length) {
            unifiedFrame = -1;
            unifiedClock.seekTo(
                unifiedPlaybackTimestamps[initialFrame] - unifiedPlaybackTimestamps[0]
            );
        } else {
            renderUnifiedFrame(initialFrame);
        }

        if (container.dataset.bpwUnifiedBound === 'true') return;
        container.dataset.bpwUnifiedBound = 'true';

        playBtn.addEventListener('click', playUnifiedReplay);
        pauseBtn.addEventListener('click', pauseUnifiedReplay);
        resetBtn.addEventListener('click', () => {
            pauseUnifiedReplay();
            if (unifiedClock) unifiedClock.reset();
            else renderUnifiedFrame(0);
        });
        timeline.addEventListener('input', () => {
            selectUnifiedFrame(Number(timeline.value));
        });
        if (speedSelect) {
            speedSelect.addEventListener('change', () => {
                const parsed = Number(speedSelect.value);
                if (!Number.isNaN(parsed) && parsed > 0 && unifiedClock) {
                    unifiedClock.setSpeed(parsed);
                }
            });
        }
    }

    function initToggleButtons() {
        document.querySelectorAll('[data-bpw-layout-toggle]').forEach((btn) => {
            ensureModeSwitch(btn);
            if (btn.dataset.bpwToggleBound === 'true') return;
            btn.dataset.bpwToggleBound = 'true';
            btn.addEventListener('click', toggleMode);
        });
        updateToggleButtons();
        updateModeSwitches();
    }

    function bootstrap() {
        applyMode(getMode());
        initToggleButtons();
    }

    function initAfterRunRender() {
        initToggleButtons();
        if (getViewMode() === VIEW_MODES.predictions && supportsPredictionsMode()) {
            applyPredictionsView();
        } else {
            applyMode(getMode());
        }
        initPanelFocusButtons();
    }

    function initSectionNav() {
        initWorkspaceDeck();
    }

    global.BpwExperimentLayout = {
        MODES,
        PERSPECTIVES,
        VIEW_MODES,
        getMode,
        setMode,
        toggleMode,
        applyMode,
        isExperiment,
        getViewMode,
        setViewMode,
        getPerspective,
        setPerspective,
        isStoryPerspective,
        applyPerspective,
        setPredictionsEnabled,
        isPredictionsEnabled,
        clearReplayPanels,
        registerReplayPanel,
        pauseUnifiedReplay,
        selectUnifiedFrame,
        initUnifiedReplay,
        initToggleButtons,
        initWorkspaceDeck,
        initSectionNav,
        initPanelFocusButtons,
        initAfterRunRender,
        resizeCharts
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap);
    } else {
        bootstrap();
    }
})(window);
