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
            <div class="replay-controls" id="single-replay-controls">
                <div class="buttons">
                    <button class="btn" id="btn-single-play">Play</button>
                    <button class="btn secondary" id="btn-single-pause">Pause</button>
                    <button class="btn secondary" id="btn-single-reset">Reset</button>
                </div>
                <div class="meta" id="single-replay-meta">Frame 0 / 0</div>
                <div class="timeline">
                    <input type="range" id="single-replay-timeline" min="0" max="0" value="0">
                    <div class="meta" id="single-replay-time-label">Elapsed: 0s</div>
                    <div class="meta">
                        Speed:
                        <select id="single-replay-speed">
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
            <div class="chart-container">
                <h4>Memory Usage Over Time</h4>
                <div class="chart-wrapper">
                    <div id="single-rss" style="width: 100%; height: 460px;"></div>
                </div>
            </div>
            ${showGC ? `
            <div class="chart-container">
                <h4>Garbage Collection Time Over Time</h4>
                <div class="chart-wrapper">
                    <div id="single-gc" style="width: 100%; height: 460px;"></div>
                </div>
            </div>
            ` : ''}
            ${showJIT ? `
            <div class="chart-container"><h4>JIT Compilation</h4>
                <div id="single-jit-time" style="width:100%;height:400px"></div>
                <div id="single-jit-rate" style="width:100%;height:400px"></div>
            </div>` : ''}
            ${showClasses ? `
            <div class="chart-container"><h4>Class Loading</h4>
                <div id="single-classes-loaded" style="width:100%;height:400px"></div>
                <div id="single-class-rate" style="width:100%;height:400px"></div>
            </div>` : ''}
        `;

        section.style.display = 'block';

        const timeline = document.getElementById('single-replay-timeline');
        const meta = document.getElementById('single-replay-meta');
        const timeLabel = document.getElementById('single-replay-time-label');
        const playBtn = document.getElementById('btn-single-play');
        const pauseBtn = document.getElementById('btn-single-pause');
        const resetBtn = document.getElementById('btn-single-reset');
        const speedSelect = document.getElementById('single-replay-speed');

        let isPlaying = false;
        let playTimer = null;
        let currentFrame = 0;
        let speedMultiplier = Number(speedSelect.value) || 15;

        timeline.max = String(Math.max(0, chartTimestamps.length - 1));

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

        function updateUi(frameIndex) {
            timeline.value = String(frameIndex);
            meta.textContent = `Frame ${frameIndex + 1} / ${chartTimestamps.length}`;
            const timestamp = chartTimestamps[frameIndex];
            const elapsed = elapsedByTimestamp.get(timestamp) || 0;
            timeLabel.textContent = `Elapsed: ${elapsed}s`;
        }

        function renderFrame(frameIndex) {
            currentFrame = frameIndex;
            updateUi(frameIndex);
            const tasks = [];

            const memoryLayout = {
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

            const rssTraces = buildMetricTraces(data, chartTimestamps, frameIndex, 'rss', {
                lineDash: 'solid',
                heapDash: 'dash',
                includeTotalRss: true,
                totalLabel: 'Total RSS Memory',
                totalColor: '#2c3e50'
            }, elapsedSeconds);
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
                const gcTraces = buildMetricTraces(data, chartTimestamps, frameIndex, 'gc', {
                    lineDash: 'solid'
                }, elapsedSeconds);
                tasks.push(Plotly.react('single-gc', applyVisibilityToTraces('single-gc', gcTraces), gcLayout, getGcConfig('build-replay-gc')));
            }
            const counterChart = (id, metric, title, yTitle) => {
                const layout = getCounterLayout(title, yTitle);
                layout.xaxis = { ...layout.xaxis, title: 'Elapsed (s)', tickformat: null, type: 'linear' };
                const traces = buildMetricTraces(data, chartTimestamps, frameIndex, metric, {}, elapsedSeconds);
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
            });
        }

        function scheduleNext() {
            if (!isPlaying) return;
            if (currentFrame >= chartTimestamps.length - 1) {
                isPlaying = false;
                return;
            }
            const nextDelay = Math.max(
                16,
                (chartTimestamps[currentFrame + 1] - chartTimestamps[currentFrame]) / speedMultiplier
            );
            playTimer = setTimeout(() => {
                renderFrame(currentFrame + 1).then(scheduleNext);
            }, nextDelay);
        }

        function play() {
            if (isPlaying) return;
            isPlaying = true;
            scheduleNext();
        }

        function pause() {
            isPlaying = false;
            if (playTimer) {
                clearTimeout(playTimer);
                playTimer = null;
            }
        }

        playBtn.addEventListener('click', play);
        pauseBtn.addEventListener('click', pause);
        resetBtn.addEventListener('click', () => {
            pause();
            renderFrame(0);
        });
        timeline.addEventListener('input', () => {
            pause();
            renderFrame(Number(timeline.value));
        });
        speedSelect.addEventListener('change', () => {
            const parsed = Number(speedSelect.value);
            if (!Number.isNaN(parsed) && parsed > 0) {
                speedMultiplier = parsed;
            }
        });

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
