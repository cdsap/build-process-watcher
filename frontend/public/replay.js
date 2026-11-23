(function () {
    const {
        parseJsonText,
        hasGCData,
        hasJITData,
        hasClassLoadingData,
        buildReplayData,
        buildMetricTraces,
        applyVisibilityToTraces,
        attachLegendVisibilityHandlers,
        setupMemoryChartFilters,
        getMemoryLayout,
        getMemoryConfig,
        getGcLayout,
        getGcConfig,
        getCounterLayout,
        getCounterConfig,
        getMedianDelta
    } = window.BpwCompareShared || {};

    const input = document.getElementById('replay-input');
    const nameEl = document.getElementById('replay-name');
    const hint = document.getElementById('replay-hint');
    const section = document.getElementById('replay-section');
    const demoBtn = document.getElementById('btn-replay-demo');
    const clearBtn = document.getElementById('btn-replay-clear');
    const dropzone = document.getElementById('replay-dropzone');

    let samples = [];
    let processInfo = {};
    let stopReplay = null;
    let activityRun = null;
    let activityController = null;

    function updateHint(message) {
        if (hint) hint.textContent = message;
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function formatDuration(seconds) {
        const s = Math.max(0, Math.round(Number(seconds) || 0));
        if (s < 60) return `${s}s`;
        const m = Math.floor(s / 60);
        const rem = s % 60;
        return rem ? `${m}m ${rem}s` : `${m}m`;
    }

    function buildReplaySummaryHtml(runSamples, runProcessInfo, replayData) {
        const list = Array.isArray(runSamples) ? runSamples : [];
        const formatMb = (value) => value > 0 ? `${value.toFixed(value >= 1000 ? 0 : 1)} MB` : 'N/A';
        let maxRss = 0;
        let maxHeap = 0;
        let maxGc = 0;
        const tsList = [];
        list.forEach((sample) => {
            if (Number.isFinite(Number(sample.Timestamp))) tsList.push(Number(sample.Timestamp));
            if (Number(sample.RSS) > maxRss) maxRss = Number(sample.RSS);
            if (Number(sample.HeapUsed) > maxHeap) maxHeap = Number(sample.HeapUsed);
            const gcSec = sample.GCTimeSeconds ?? (sample.GCTime != null && !Number.isNaN(Number(sample.GCTime)) ? Number(sample.GCTime) / 1000 : 0);
            if (Number(gcSec) > maxGc) maxGc = Number(gcSec);
        });
        (replayData?.totalRss || []).forEach((v) => {
            if (Number(v) > maxRss) maxRss = Number(v);
        });
        const durationSec = tsList.length >= 2
            ? Math.max(0, (Math.max(...tsList) - Math.min(...tsList)) / 1000)
            : 0;
        const processCount = new Set(list.map((s) => `${s.Name}|${s.PID}`)).size;
        const pressure = maxRss > 0 && maxHeap > 0 ? Math.min(999, (maxHeap / maxRss) * 100) : 0;

        return `
            <div class="run-kpi-strip replay-summary-strip" aria-label="Replay summary">
                <div class="run-kpi">
                    <div class="run-kpi-label">Peak RSS</div>
                    <div class="run-kpi-value">${formatMb(maxRss)}</div>
                    <div class="run-kpi-note">${processCount} process${processCount === 1 ? '' : 'es'}</div>
                </div>
                <div class="run-kpi">
                    <div class="run-kpi-label">Peak Heap</div>
                    <div class="run-kpi-value">${formatMb(maxHeap)}</div>
                    <div class="run-kpi-note">${pressure > 0 ? `${pressure.toFixed(0)}% of peak RSS` : 'Heap signal unavailable'}</div>
                </div>
                <div class="run-kpi">
                    <div class="run-kpi-label">GC Time</div>
                    <div class="run-kpi-value">${maxGc > 0 ? `${maxGc.toFixed(2)} s` : 'N/A'}</div>
                    <div class="run-kpi-note">Highest cumulative process value</div>
                </div>
                <div class="run-kpi">
                    <div class="run-kpi-label">Duration</div>
                    <div class="run-kpi-value">${durationSec > 0 ? formatDuration(durationSec) : 'N/A'}</div>
                    <div class="run-kpi-note">${list.length} samples</div>
                </div>
            </div>`;
    }

    function buildReplayProcessInfoHtml(runSamples, runProcessInfo) {
        const entries = Object.entries(runProcessInfo || {});
        if (!entries.length) return '';
        const formatMb = (value) => value > 0 ? `${value.toFixed(value >= 1000 ? 0 : 1)} MB` : 'N/A';
        const cards = entries.map(([pid, info]) => {
            const pSamples = runSamples.filter((s) => String(s.PID) === String(pid));
            let maxRss = 0;
            let maxHeap = 0;
            let maxGc = 0;
            pSamples.forEach((s) => {
                if (Number(s.RSS) > maxRss) maxRss = Number(s.RSS);
                if (Number(s.HeapUsed) > maxHeap) maxHeap = Number(s.HeapUsed);
                const gcSec = s.GCTimeSeconds ?? (s.GCTime != null ? Number(s.GCTime) / 1000 : 0);
                if (Number(gcSec) > maxGc) maxGc = Number(gcSec);
            });
            const vmFlags = Array.isArray(info?.vm_flags) ? info.vm_flags : [];
            return `
                <article class="process-info-card">
                    <div class="process-card-main">
                        <div class="process-card-title">
                            <strong>${escapeHtml(info?.name || 'Process')} · PID ${escapeHtml(pid)}</strong>
                            <span>${pSamples.length} samples</span>
                        </div>
                    </div>
                    <div class="process-metric-grid">
                        <div class="process-metric"><strong>Max RSS</strong><span>${formatMb(maxRss)}</span></div>
                        <div class="process-metric"><strong>Max Heap</strong><span>${formatMb(maxHeap)}</span></div>
                        <div class="process-metric"><strong>GC Time</strong><span>${maxGc > 0 ? `${maxGc.toFixed(2)} s` : 'N/A'}</span></div>
                    </div>
                    ${vmFlags.length ? `
                        <details class="process-details">
                            <summary>VM flags (${vmFlags.length})</summary>
                            <div class="vm-flags-list">${vmFlags.map((flag) => `<span class="vm-flag">${escapeHtml(flag)}</span>`).join('')}</div>
                        </details>` : ''}
                </article>`;
        }).join('');
        return `
            <div class="process-info-section">
                <div class="process-info-head">
                    <div><h2>Process Information</h2></div>
                </div>
                <div class="process-groups">${cards}</div>
            </div>`;
    }

    async function exportReplayChart(chartId, filenameBase, format) {
        const chart = document.getElementById(chartId);
        if (!chart || typeof Plotly === 'undefined') return;
        try {
            const isMobile = window.innerWidth < 768;
            const url = await Plotly.toImage(chart, {
                format,
                filename: filenameBase,
                height: isMobile ? 400 : 500,
                width: isMobile ? 800 : 1000,
                scale: 2,
            });
            const a = document.createElement('a');
            a.href = url;
            a.download = `${filenameBase}.${format}`;
            document.body.appendChild(a);
            a.click();
            a.remove();
        } catch (err) {
            console.error('Failed to export replay chart:', err);
        }
    }

    function renderReplay() {
        if (!section || !samples.length) {
            updateHint('Select a JSON file to render the replay.');
            return;
        }

        if (typeof stopReplay === 'function') {
            stopReplay();
            stopReplay = null;
        }

        const timestamps = [...new Set(samples.map(s => s.Timestamp))].sort((a, b) => a - b);
        const data = buildReplayData(samples, timestamps);
        const chartTimestamps = data.timestamps || timestamps;
        const elapsedSeconds = chartTimestamps.map(ts => Math.max(0, (ts - chartTimestamps[0]) / 1000));
        const showGC = hasGCData(samples);
        const showJIT = hasJITData(samples);
        const showClasses = hasClassLoadingData(samples);

        section.innerHTML = `
            ${buildReplaySummaryHtml(samples, processInfo, data)}
            ${window.BpwChartPanels.render({
            chartIdPrefix: 'single-',
            headingLevel: 4,
            chartHeights: { memory: 460, gc: 460, runtime: 400 },
            showGC,
            showJIT,
            showClasses,
            includeUnifiedReplay: true,
            beforeGrid: `
            <div class="downloads-toolbar" id="single-downloads-toolbar">
                <button class="btn" type="button" id="btn-single-download-png">Download Memory PNG</button>
                <button class="btn secondary" type="button" id="btn-single-download-svg">Download Memory SVG</button>
                ${showGC ? `
                <button class="btn secondary" type="button" id="btn-single-download-gc-png">Download GC PNG</button>
                <button class="btn secondary" type="button" id="btn-single-download-gc-svg">Download GC SVG</button>
                ` : ''}
            </div>
            <div class="replay-controls" id="single-replay-controls">
                <div class="buttons">
                    <button class="btn" type="button" id="btn-single-play">Play</button>
                    <button class="btn secondary" type="button" id="btn-single-pause">Pause</button>
                    <button class="btn secondary" type="button" id="btn-single-reset">Reset</button>
                </div>
                <div class="meta" id="single-replay-meta">Frame 0 / 0</div>
                <div class="timeline">
                    <input type="range" id="single-replay-timeline" aria-label="Replay position" min="0" max="0" value="0">
                    <div class="meta" id="single-replay-time-label">Elapsed: 0s</div>
                    <div class="meta">
                        Speed:
                        <select id="single-replay-speed" aria-label="Playback speed">
                            <option value="5">5x</option>
                            <option value="10">10x</option>
                            <option value="15" selected>15x</option>
                            <option value="20">20x</option>
                            <option value="25">25x</option>
                            <option value="30">30x</option>
                            <option value="35">35x</option>
                            <option value="40">40x</option>
                            <option value="45">45x</option>
                            <option value="50">50x</option>
                        </select>
                    </div>
                </div>
            </div>
            <div class="chart-filters" id="single-chart-filters">
                <label><input type="checkbox" id="filter-single-total-rss" checked> Total RSS</label>
                <label><input type="checkbox" id="filter-single-rss" checked> RSS</label>
                <label><input type="checkbox" id="filter-single-heap" checked> Heap</label>
            </div>
            `,
        })}
            ${buildReplayProcessInfoHtml(samples, processInfo)}`;

        activityController?.stop();
        activityController = null;
        if (activityRun?.prediction_target === 'class_loading' && window.BpwPredictionView) {
            const activityHost = document.createElement('div');
            section.appendChild(activityHost);
            activityController = BpwPredictionView.bindProcessForecastView(activityHost, {data: {...activityRun, samples, finished: true}, initialMode: 'replay'});
        }
        section.style.display = 'block';

        if (window.BpwExperimentLayout) {
            BpwExperimentLayout.clearReplayPanels();
            BpwExperimentLayout.initToggleButtons?.();
            BpwExperimentLayout.applyMode?.(BpwExperimentLayout.getMode());
            const initDeck = BpwExperimentLayout.initWorkspaceDeck || BpwExperimentLayout.initSectionNav;
            if (typeof initDeck === 'function') initDeck();
            BpwExperimentLayout.initPanelFocusButtons?.();
        }

        const timeline = document.getElementById('single-replay-timeline');
        const meta = document.getElementById('single-replay-meta');
        const timeLabel = document.getElementById('single-replay-time-label');
        const playBtn = document.getElementById('btn-single-play');
        const pauseBtn = document.getElementById('btn-single-pause');
        const resetBtn = document.getElementById('btn-single-reset');
        const speedSelect = document.getElementById('single-replay-speed');

        let currentFrame = 0;
        let lastRenderedSampleIdx = -1;
        let chartControlsBound = false;
        const memoryGapLimitMs = (getMedianDelta(chartTimestamps) || 0) * 2;
        const memoryValuePool = [];
        (data.totalRss || []).forEach((value) => {
            if (value !== null && value !== undefined) memoryValuePool.push(value);
        });
        Object.values(data.series || {}).forEach((def) => {
            (def.rss || []).forEach((value) => { if (value !== null && value !== undefined) memoryValuePool.push(value); });
            (def.heap || []).forEach((value) => { if (value !== null && value !== undefined) memoryValuePool.push(value); });
        });
        const memoryXDomain = BpwChartViewport.timeDomain(elapsedSeconds);
        const memoryYDomain = BpwChartViewport.memoryDomain(memoryValuePool);

        const elapsedByTimestamp = new Map();
        samples.forEach(sample => {
            if (!elapsedByTimestamp.has(sample.Timestamp)) {
                elapsedByTimestamp.set(sample.Timestamp, sample.ElapsedTime);
            }
        });

        function withVisualEndpoints(traces, frameIndex, playheadAbsoluteMs, allowVisual) {
            if (!allowVisual) return traces;
            return traces.map((trace) => {
                if (!trace?.name) return trace;
                const isRss = trace.name.includes('(RSS)') || trace.name === 'Total RSS Memory';
                const isHeap = trace.name.includes('(Heap)');
                if (!isRss && !isHeap) return trace;
                let values = null;
                if (trace.name === 'Total RSS Memory') values = data.totalRss;
                else {
                    const match = Object.values(data.series || {}).find((def) => (
                        trace.name === `${def.processName} PID:${def.pid} (${isRss ? 'RSS' : 'Heap'})`
                    ));
                    values = match ? (isRss ? match.rss : match.heap) : null;
                }
                if (!values) return trace;
                const endpoint = BpwChartViewport.visualEndpoint(
                    chartTimestamps,
                    values,
                    playheadAbsoluteMs,
                    memoryGapLimitMs,
                );
                if (!endpoint || endpoint.lowerIndex > frameIndex) return trace;
                const visualX = (endpoint.time - chartTimestamps[0]) / 1000;
                return {
                    ...trace,
                    x: (trace.x || []).concat([visualX]),
                    y: (trace.y || []).concat([endpoint.value]),
                };
            });
        }

        function updateUi(position) {
            const sampleIndex = Math.max(0, position.sampleIndex);
            currentFrame = sampleIndex;
            timeline.max = String(Math.max(0, Math.round(position.durationMs)));
            timeline.value = String(Math.round(position.cursorMs));
            const elapsedSec = Math.round(position.cursorMs / 1000);
            meta.textContent = `Elapsed ${elapsedSec}s · Sample ${sampleIndex + 1} / ${position.sampleCount}`;
            const recorded = elapsedByTimestamp.get(chartTimestamps[sampleIndex]) || elapsedSec;
            timeLabel.textContent = `Playhead: ${elapsedSec}s | sample ${recorded}s`;
        }

        function renderFrame(frameIndex, playheadAbsoluteMs, allowVisual) {
            const idx = Math.max(0, Math.min(
                Number.isFinite(frameIndex) ? frameIndex : chartTimestamps.length - 1,
                chartTimestamps.length - 1,
            ));
            const sampleChanged = idx !== lastRenderedSampleIdx;
            currentFrame = idx;
            lastRenderedSampleIdx = idx;
            const absoluteMs = Number.isFinite(playheadAbsoluteMs) ? playheadAbsoluteMs : chartTimestamps[idx];
            if (sampleChanged) {
                activityController?.seekTo(absoluteMs);
            }
            const tasks = [];

            let memoryLayout = {
                ...getMemoryLayout(),
                xaxis: {
                    ...getMemoryLayout().xaxis,
                    title: 'Elapsed (s)',
                    tickformat: null,
                    type: 'linear'
                },
                legend: {
                    x: 0.5,
                    y: -0.25,
                    xanchor: 'center',
                    orientation: 'h'
                },
                margin: {
                    ...getMemoryLayout().margin,
                    b: 110
                }
            };
            memoryLayout = BpwChartViewport.applyFixedRanges(memoryLayout, {
                x: memoryXDomain,
                y: memoryYDomain,
                uirevision: 'replay:memory',
            });

            const rssTraces = withVisualEndpoints(
                buildMetricTraces(data, chartTimestamps, idx, 'rss', {
                    lineDash: 'solid',
                    heapDash: 'dash',
                    includeTotalRss: true,
                    totalLabel: 'Total RSS Memory',
                    totalColor: '#2c3e50'
                }, elapsedSeconds),
                idx,
                absoluteMs,
                allowVisual,
            );
            tasks.push(Plotly.react('single-rss', applyVisibilityToTraces('single-rss', rssTraces), memoryLayout, getMemoryConfig('build-replay')));

            if (sampleChanged) {
                if (showGC) {
                    const gcLayout = {
                        ...getGcLayout(),
                        xaxis: {
                            ...getGcLayout().xaxis,
                            title: 'Elapsed (s)',
                            tickformat: null,
                            type: 'linear'
                        },
                        legend: {
                            x: 0.5,
                            y: -0.25,
                            xanchor: 'center',
                            orientation: 'h'
                        },
                        margin: {
                            ...getGcLayout().margin,
                            b: 110
                        }
                    };
                    const gcTraces = buildMetricTraces(data, chartTimestamps, idx, 'gc', {
                        lineDash: 'solid'
                    }, elapsedSeconds);
                    tasks.push(Plotly.react('single-gc', applyVisibilityToTraces('single-gc', gcTraces), gcLayout, getGcConfig('build-replay-gc')));
                }
                const counterChart = (id, metric, title, yTitle) => {
                    const layout = getCounterLayout(title, yTitle);
                    layout.xaxis = { ...layout.xaxis, title: 'Elapsed (s)', tickformat: null, type: 'linear' };
                    const traces = buildMetricTraces(data, chartTimestamps, idx, metric, {}, elapsedSeconds);
                    tasks.push(Plotly.react(id, applyVisibilityToTraces(id, traces), layout, getCounterConfig(`build-replay-${metric}`)));
                };
                if (showJIT) {
                    counterChart('single-jit-time', 'jitTime', 'Cumulative JIT Compilation Time', 'Compilation Time (s)');
                    counterChart('single-jit-rate', 'jitRate', 'JIT Compilation Activity', 'Compiled Methods / s');
                }
                if (showClasses) {
                    counterChart('single-classes-loaded', 'classesLoaded', 'Cumulative Classes Loaded', 'Classes Loaded');
                    counterChart('single-class-rate', 'classRate', 'Class Loading Activity', 'Classes / s');
                }
            }

            return Promise.all(tasks).then(() => {
                if (chartControlsBound) return;
                chartControlsBound = true;
                setupMemoryChartFilters('single-rss', 'filter-single-total-rss', 'filter-single-rss', 'filter-single-heap');
                if (showGC) {
                    attachLegendVisibilityHandlers('single-gc');
                }
                ['single-jit-time', 'single-jit-rate', 'single-classes-loaded', 'single-class-rate']
                    .forEach(id => { if (document.getElementById(id)) attachLegendVisibilityHandlers(id); });
                if (window.BpwExperimentLayout) {
                    BpwExperimentLayout.resizeCharts();
                }
            });
        }

        let latestRender = Promise.resolve();
        const coalescer = BpwChartViewport.createRenderCoalescer({
            minIntervalMs: 70,
            render: (position, token) => {
                updateUi(position);
                latestRender = renderFrame(
                    position.sampleIndex,
                    position.absoluteMs,
                    !position.reducedMotion,
                );
                return Promise.resolve(latestRender).then((result) => (
                    token === coalescer.getGeneration() ? result : null
                ));
            },
        });
        const clock = BpwPlaybackClock.createPlaybackClock({
            timestamps: chartTimestamps,
            speed: Number(speedSelect.value) || 15,
            onPosition: (position) => {
                updateUi(position);
                coalescer.enqueue(position);
            },
        });

        function pause() {
            clock.pause();
        }

        stopReplay = () => {
            pause();
            coalescer.cancel();
            clock.destroy();
        };

        playBtn.addEventListener('click', () => clock.play());
        pauseBtn.addEventListener('click', pause);
        resetBtn.addEventListener('click', () => clock.reset());
        timeline.addEventListener('input', () => {
            // Read before pause(): pause emits onPosition and may synchronously rewrite the slider.
            const targetMs = Number(timeline.value);
            if (clock.getState().playing) pause();
            coalescer.cancel();
            clock.seekTo(targetMs);
        });
        speedSelect.addEventListener('change', () => {
            const parsed = Number(speedSelect.value);
            if (!Number.isNaN(parsed) && parsed > 0) clock.setSpeed(parsed);
        });

        function renderFrameByIndex(frameIndex) {
            const idx = Math.max(0, Math.min(frameIndex, chartTimestamps.length - 1));
            clock.seekTo(chartTimestamps[idx] - chartTimestamps[0]);
            return latestRender;
        }

        clock.seekTo(Math.max(0, chartTimestamps[chartTimestamps.length - 1] - chartTimestamps[0]));

        if (window.BpwChartStudio) {
            BpwChartStudio.init({
                samples,
                replayData: data,
                runId: 'replay',
                useElapsedAxis: true,
                initialFrame: Math.max(0, chartTimestamps.length - 1)
            });
        }
        if (window.BpwBuildStory) {
            BpwBuildStory.init({
                samples,
                replayData: data,
                runId: 'replay',
                useElapsedAxis: true,
                initialFrame: Math.max(0, chartTimestamps.length - 1)
            });
        }

        const onKeydown = (event) => {
            const tag = event.target?.tagName;
            if (tag === 'SELECT' || tag === 'INPUT' || tag === 'TEXTAREA') return;
            if (event.key === ' ' || event.code === 'Space') {
                event.preventDefault();
                if (clock.getState().playing) pause();
                else clock.play();
            } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault();
                pause();
                const delta = event.key === 'ArrowRight' ? 1 : -1;
                renderFrameByIndex(currentFrame + delta);
            }
        };
        const controlsBox = document.getElementById('single-replay-controls');
        if (controlsBox) controlsBox.addEventListener('keydown', onKeydown);

        const btnDlPng = document.getElementById('btn-single-download-png');
        const btnDlSvg = document.getElementById('btn-single-download-svg');
        const btnDlGcPng = document.getElementById('btn-single-download-gc-png');
        const btnDlGcSvg = document.getElementById('btn-single-download-gc-svg');
        if (btnDlPng) btnDlPng.addEventListener('click', () => exportReplayChart('single-rss', 'build-replay-memory', 'png'));
        if (btnDlSvg) btnDlSvg.addEventListener('click', () => exportReplayChart('single-rss', 'build-replay-memory', 'svg'));
        if (btnDlGcPng) btnDlGcPng.addEventListener('click', () => exportReplayChart('single-gc', 'build-replay-gc', 'png'));
        if (btnDlGcSvg) btnDlGcSvg.addEventListener('click', () => exportReplayChart('single-gc', 'build-replay-gc', 'svg'));

        if (window.BpwExperimentLayout) {
            BpwExperimentLayout.registerReplayPanel({
                pause,
                renderFrame: renderFrameByIndex,
                getMaxFrame: () => chartTimestamps.length - 1
            });
            BpwExperimentLayout.initUnifiedReplay({
                timestamps: chartTimestamps,
                elapsedByTimestamp
            });
        }
    }

    function loadJsonText(text, label) {
        activityController?.stop();
        activityController = null;
        try {
            const parsed = parseJsonText(text);
            if (!parsed.samples || !parsed.samples.length) {
                samples = [];
                processInfo = {};
                if (section) section.style.display = 'none';
                if (clearBtn) clearBtn.disabled = true;
                updateHint('JSON is missing samples.');
                return;
            }
            samples = parsed.samples;
            processInfo = parsed.processInfo || {};
            activityRun = parsed.raw;
            if (nameEl) nameEl.textContent = label;
            if (clearBtn) clearBtn.disabled = false;
            renderReplay();
            updateHint('Replay rendered below.');
        } catch (err) {
            console.error('Failed to parse JSON', err);
            samples = [];
            processInfo = {};
            if (section) section.style.display = 'none';
            if (nameEl) nameEl.textContent = 'Failed to parse JSON';
            if (clearBtn) clearBtn.disabled = true;
            updateHint('Failed to parse JSON. Please check the file format.');
        }
    }

    function loadFile(file) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => loadJsonText(String(reader.result || ''), file.name);
        reader.readAsText(file);
    }

    if (input) {
        input.addEventListener('change', () => {
            loadFile(input.files && input.files[0]);
        });
    }

    if (demoBtn) {
        demoBtn.addEventListener('click', async () => {
            updateHint('Loading demo run...');
            try {
                const response = await fetch('/demo-run.json');
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const text = await response.text();
                loadJsonText(text, 'demo-run.json');
            } catch (err) {
                console.error('Failed to load demo run', err);
                updateHint('Failed to load demo run.');
            }
        });
    }

    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            if (typeof stopReplay === 'function') {
                stopReplay();
                stopReplay = null;
            }
            activityController?.stop();
            activityController = null;
            samples = [];
            processInfo = {};
            activityRun = null;
            if (input) input.value = '';
            if (nameEl) nameEl.textContent = 'No file selected';
            if (section) {
                section.style.display = 'none';
                section.innerHTML = '';
            }
            clearBtn.disabled = true;
            updateHint('Select, drop a JSON file, or load the demo run.');
        });
    }

    if (dropzone) {
        dropzone.addEventListener('dragover', (event) => {
            event.preventDefault();
            dropzone.classList.add('is-dragover');
        });
        dropzone.addEventListener('dragleave', () => {
            dropzone.classList.remove('is-dragover');
        });
        dropzone.addEventListener('drop', (event) => {
            event.preventDefault();
            dropzone.classList.remove('is-dragover');
            const file = Array.from(event.dataTransfer?.files || [])
                .find((f) => /\.json$/i.test(f.name) || f.type === 'application/json');
            if (file) loadFile(file);
        });
    }
})();
