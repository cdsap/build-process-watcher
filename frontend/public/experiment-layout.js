(function (global) {
    const STORAGE_KEY = 'bpwLayoutMode';
    const MODES = { classic: 'classic', experiment: 'experiment' };

    const replayPanels = [];
    let unifiedTimer = null;
    let unifiedPlaying = false;
    let unifiedFrame = 0;
    let unifiedSpeed = 15;
    let unifiedTimestamps = [];
    let unifiedElapsedByTimestamp = null;

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

    function updateToggleButtons() {
        const experimentActive = isExperiment();
        document.querySelectorAll('[data-bpw-layout-toggle]').forEach((btn) => {
            btn.textContent = experimentActive ? 'Classic layout' : 'Experiment layout';
            btn.setAttribute('aria-pressed', experimentActive ? 'true' : 'false');
            btn.title = experimentActive
                ? 'Switch back to the classic stacked chart layout'
                : 'Try the experimental dashboard grid with unified replay';
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
        }, 160);
    }

    function applyMode(mode) {
        const experiment = mode === MODES.experiment;
        document.body.classList.toggle('bpw-layout-experiment', experiment);
        document.body.classList.toggle('bpw-layout-classic', !experiment);

        const nav = document.getElementById('bpw-section-nav');
        const unified = document.getElementById('bpw-unified-replay');
        if (nav) nav.hidden = !experiment;
        if (unified) unified.hidden = !experiment;

        updateToggleButtons();
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

    function initSectionNav() {
        const nav = document.getElementById('bpw-section-nav');
        if (!nav || nav.dataset.bpwNavBound === 'true') return;
        nav.dataset.bpwNavBound = 'true';
        nav.addEventListener('click', (event) => {
            const link = event.target.closest('a[href^="#"]');
            if (!link) return;
            const id = link.getAttribute('href').slice(1);
            const target = document.getElementById(id);
            if (target) {
                event.preventDefault();
                target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        });
    }

    function bootstrap() {
        applyMode(getMode());
        initToggleButtons();
        initSectionNav();
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
        initSectionNav,
        resizeCharts
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap);
    } else {
        bootstrap();
    }
})(window);
