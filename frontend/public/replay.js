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
        getMemoryLayout,
        getMemoryConfig,
        getGcLayout,
        getGcConfig,
        getCounterLayout,
        getCounterConfig,
        getMedianDelta,
        visibilityStore
    } = window.BpwCompareShared || {};

    const input = document.getElementById('replay-input');
    const nameEl = document.getElementById('replay-name');
    const hint = document.getElementById('replay-hint');
    const section = document.getElementById('replay-section');

    let samples = [];

    function updateHint(message) {
        if (hint) hint.textContent = message;
    }

    function renderReplay() {
        if (!section || !samples.length) {
            updateHint('Select a JSON file to render the replay.');
            return;
        }

        const timestamps = [...new Set(samples.map(s => s.Timestamp))].sort((a, b) => a - b);
        const data = buildReplayData(samples, timestamps);
        const chartTimestamps = data.timestamps || timestamps;
        const elapsedSeconds = chartTimestamps.map(ts => Math.max(0, (ts - chartTimestamps[0]) / 1000));
        const showGC = hasGCData(samples);
        const showJIT = hasJITData(samples);
        const showClasses = hasClassLoadingData(samples);

        section.innerHTML = `
            <div id="bpw-unified-replay" class="bpw-unified-replay" hidden>
                <div class="bpw-unified-label">Unified replay (all charts)</div>
                <div class="replay-controls" id="bpw-unified-replay-controls">
                    <div class="buttons">
                        <button class="btn" id="bpw-unified-play" type="button">Play</button>
                        <button class="btn secondary" id="bpw-unified-pause" type="button">Pause</button>
                        <button class="btn secondary" id="bpw-unified-reset" type="button">Reset</button>
                    </div>
                    <div class="meta" id="bpw-unified-meta">Frame 0 / 0</div>
                    <div class="timeline">
                        <input type="range" id="bpw-unified-timeline" aria-label="Replay position" min="0" max="0" value="0">
                        <div class="meta" id="bpw-unified-time-label">Elapsed: 0s</div>
                        <div class="meta">
                            Speed:
                            <select id="bpw-unified-speed" aria-label="Playback speed">
                                <option value="15" selected>15x</option>
                                <option value="25">25x</option>
                                <option value="50">50x</option>
                            </select>
                        </div>
                    </div>
                </div>
            </div>
            <div id="bpw-workspace-deck" class="bpw-workspace-deck" hidden aria-label="Workspace layout"></div>
            <div id="bpw-chart-studio" class="bpw-chart-studio" hidden aria-label="Chart overlay studio"></div>
            <div id="bpw-build-story" class="bpw-build-story" hidden aria-label="Build story timeline"></div>
            <div class="replay-controls" id="single-replay-controls">
                <div class="buttons">
                    <button class="btn" id="btn-single-play">Play</button>
                    <button class="btn secondary" id="btn-single-pause">Pause</button>
                    <button class="btn secondary" id="btn-single-reset">Reset</button>
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
            <div id="bpw-charts-grid" class="bpw-charts-grid">
            <section class="bpw-chart-panel" data-bpw-panel="memory" id="section-memory">
            <div class="bpw-panel-card">
                <div class="bpw-panel-card-head">
                    <div>
                        <span class="bpw-panel-badge">Memory</span>
                        <h4>Memory Usage Over Time</h4>
                    </div>
                    <button type="button" class="bpw-panel-focus-btn" data-bpw-focus="memory" title="Expand this panel">Expand</button>
                </div>
                <div class="bpw-panel-card-body">
            <div class="chart-container">
                <div class="chart-wrapper">
                    <div id="single-rss" style="width: 100%; height: 460px;"></div>
                </div>
            </div>
                </div>
            </div>
            </section>
            ${showGC ? `
            <section class="bpw-chart-panel" data-bpw-panel="gc" id="section-gc">
            <div class="bpw-panel-card">
                <div class="bpw-panel-card-head">
                    <div>
                        <span class="bpw-panel-badge">GC</span>
                        <h4>Garbage Collection Time</h4>
                    </div>
                    <button type="button" class="bpw-panel-focus-btn" data-bpw-focus="gc" title="Expand this panel">Expand</button>
                </div>
                <div class="bpw-panel-card-body">
            <div class="chart-container">
                <div class="chart-wrapper">
                    <div id="single-gc" style="width: 100%; height: 460px;"></div>
                </div>
            </div>
                </div>
            </div>
            </section>
            ` : ''}
            ${(showJIT || showClasses) ? `<div class="bpw-runtime-stage">` : ''}
            ${showJIT ? `
            <section class="bpw-chart-panel" data-bpw-panel="jit-time" id="section-jit-time">
            <div class="bpw-panel-card">
                <div class="bpw-panel-card-head">
                    <div>
                        <span class="bpw-panel-badge">JIT</span>
                        <h4>Cumulative Compilation Time</h4>
                    </div>
                    <button type="button" class="bpw-panel-focus-btn" data-bpw-focus="jit-time" title="Expand this panel">Expand</button>
                </div>
                <div class="bpw-panel-card-body">
                    <div class="chart-container">
                        <div class="chart-wrapper">
                            <div id="single-jit-time" class="bpw-chart-plot" style="width:100%;height:400px"></div>
                        </div>
                    </div>
                </div>
            </div>
            </section>
            <section class="bpw-chart-panel" data-bpw-panel="jit-rate" id="section-jit-rate">
            <div class="bpw-panel-card">
                <div class="bpw-panel-card-head">
                    <div>
                        <span class="bpw-panel-badge">JIT</span>
                        <h4>Compilation Activity</h4>
                    </div>
                    <button type="button" class="bpw-panel-focus-btn" data-bpw-focus="jit-rate" title="Expand this panel">Expand</button>
                </div>
                <div class="bpw-panel-card-body">
                    <div class="chart-container">
                        <div class="chart-wrapper">
                            <div id="single-jit-rate" class="bpw-chart-plot" style="width:100%;height:400px"></div>
                        </div>
                    </div>
                </div>
            </div>
            </section>` : ''}
            ${showClasses ? `
            <section class="bpw-chart-panel" data-bpw-panel="classes-loaded" id="section-classes-loaded">
            <div class="bpw-panel-card">
                <div class="bpw-panel-card-head">
                    <div>
                        <span class="bpw-panel-badge">Classes</span>
                        <h4>Cumulative Classes Loaded</h4>
                    </div>
                    <button type="button" class="bpw-panel-focus-btn" data-bpw-focus="classes-loaded" title="Expand this panel">Expand</button>
                </div>
                <div class="bpw-panel-card-body">
                    <div class="chart-container">
                        <div class="chart-wrapper">
                            <div id="single-classes-loaded" class="bpw-chart-plot" style="width:100%;height:400px"></div>
                        </div>
                    </div>
                </div>
            </div>
            </section>
            <section class="bpw-chart-panel" data-bpw-panel="class-rate" id="section-class-rate">
            <div class="bpw-panel-card">
                <div class="bpw-panel-card-head">
                    <div>
                        <span class="bpw-panel-badge">Classes</span>
                        <h4>Class Loading Activity</h4>
                    </div>
                    <button type="button" class="bpw-panel-focus-btn" data-bpw-focus="class-rate" title="Expand this panel">Expand</button>
                </div>
                <div class="bpw-panel-card-body">
                    <div class="chart-container">
                        <div class="chart-wrapper">
                            <div id="single-class-rate" class="bpw-chart-plot" style="width:100%;height:400px"></div>
                        </div>
                    </div>
                </div>
            </div>
            </section>` : ''}
            ${(showJIT || showClasses) ? `</div>` : ''}
            </div>
        `;

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

        const traceVisibility = visibilityStore || {};

        function updateSingleReplayFilterCheckboxes() {
            const total = document.getElementById('filter-single-total-rss');
            const rss = document.getElementById('filter-single-rss');
            const heap = document.getElementById('filter-single-heap');
            const chart = document.getElementById('single-rss');
            if (!total || !rss || !heap || !chart || !chart.data) return;
            const map = traceVisibility['single-rss'] || {};
            let rssVisible = false;
            let heapVisible = false;
            chart.data.forEach(trace => {
                if (!trace.name) return;
                const vis = map[trace.name];
                const isVisible = vis !== 'legendonly' && vis !== false;
                if (trace.name === 'Total RSS Memory') {
                    /* total handled below */
                } else if (trace.name.includes('(RSS)')) {
                    rssVisible = rssVisible || isVisible;
                } else if (trace.name.includes('(Heap)')) {
                    heapVisible = heapVisible || isVisible;
                }
            });
            const totalVis = map['Total RSS Memory'];
            total.checked = totalVis === undefined ? true : (totalVis !== 'legendonly' && totalVis !== false);
            rss.checked = rssVisible;
            heap.checked = heapVisible;
        }

        function setupSingleReplayFilters() {
            const total = document.getElementById('filter-single-total-rss');
            const rss = document.getElementById('filter-single-rss');
            const heap = document.getElementById('filter-single-heap');
            if (!total || !rss || !heap) return;
            const applyFilters = () => {
                const chart = document.getElementById('single-rss');
                if (!chart || !chart.data) return;
                const map = traceVisibility['single-rss'] || (traceVisibility['single-rss'] = {});
                chart.data.forEach(trace => {
                    if (!trace.name) return;
                    if (trace.name === 'Total RSS Memory') {
                        map[trace.name] = total.checked ? true : 'legendonly';
                    } else if (trace.name.includes('(RSS)')) {
                        map[trace.name] = rss.checked ? true : 'legendonly';
                    } else if (trace.name.includes('(Heap)')) {
                        map[trace.name] = heap.checked ? true : 'legendonly';
                    }
                });
                const visArray = chart.data.map(trace => map[trace.name] !== undefined ? map[trace.name] : true);
                Plotly.restyle(chart, 'visible', visArray);
            };
            total.addEventListener('change', applyFilters);
            rss.addEventListener('change', applyFilters);
            heap.addEventListener('change', applyFilters);
            applyFilters();
        }

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
            currentFrame = idx;
            const absoluteMs = Number.isFinite(playheadAbsoluteMs) ? playheadAbsoluteMs : chartTimestamps[idx];
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

            return Promise.all(tasks).then(() => {
                setupSingleReplayFilters();
                attachLegendVisibilityHandlers('single-rss', updateSingleReplayFilterCheckboxes);
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
            onPosition: (position) => coalescer.enqueue(position),
        });

        function pause() {
            clock.pause();
        }

        playBtn.addEventListener('click', () => clock.play());
        pauseBtn.addEventListener('click', pause);
        resetBtn.addEventListener('click', () => clock.reset());
        timeline.addEventListener('input', () => {
            pause();
            clock.seekTo(Number(timeline.value));
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
                runId: 'replay',
                useElapsedAxis: true,
                initialFrame: Math.max(0, chartTimestamps.length - 1)
            });
        }
        if (window.BpwBuildStory) {
            BpwBuildStory.init({
                samples,
                runId: 'replay',
                useElapsedAxis: true,
                initialFrame: Math.max(0, chartTimestamps.length - 1)
            });
        }

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

        renderFrame(0);
    }

    if (input) {
        input.addEventListener('change', () => {
            const file = input.files && input.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const text = String(reader.result || '');
                    const parsed = parseJsonText(text);
                    if (!parsed.samples || !parsed.samples.length) {
                        samples = [];
                        if (section) section.style.display = 'none';
                        updateHint('JSON is missing samples.');
                        return;
                    }
                    samples = parsed.samples;
                    if (nameEl) nameEl.textContent = file.name;
                    renderReplay();
                    updateHint('Replay rendered below.');
                } catch (err) {
                    console.error('Failed to parse JSON', err);
                    samples = [];
                    if (section) section.style.display = 'none';
                    if (nameEl) nameEl.textContent = 'Failed to parse JSON';
                    updateHint('Failed to parse JSON. Please check the file format.');
                }
            };
            reader.readAsText(file);
        });
    }
})();
