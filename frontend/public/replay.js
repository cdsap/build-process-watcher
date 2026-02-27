(function () {
    const {
        parseJsonText,
        hasGCData,
        buildReplayData,
        buildMetricTraces,
        applyVisibilityToTraces,
        attachLegendVisibilityHandlers,
        getMemoryLayout,
        getMemoryConfig,
        getGcLayout,
        getGcConfig
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
        const elapsedSeconds = timestamps.map(ts => Math.max(0, (ts - timestamps[0]) / 1000));
        const data = buildReplayData(samples, timestamps);
        const showGC = hasGCData(samples);

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

        timeline.max = String(Math.max(0, timestamps.length - 1));

        const elapsedByTimestamp = new Map();
        samples.forEach(sample => {
            if (!elapsedByTimestamp.has(sample.Timestamp)) {
                elapsedByTimestamp.set(sample.Timestamp, sample.ElapsedTime);
            }
        });

        function updateUi(frameIndex) {
            timeline.value = String(frameIndex);
            meta.textContent = `Frame ${frameIndex + 1} / ${timestamps.length}`;
            const timestamp = timestamps[frameIndex];
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

            const rssTraces = buildMetricTraces(data, timestamps, frameIndex, 'rss', {
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
                const gcTraces = buildMetricTraces(data, timestamps, frameIndex, 'gc', {
                    lineDash: 'solid'
                }, elapsedSeconds);
                tasks.push(Plotly.react('single-gc', applyVisibilityToTraces('single-gc', gcTraces), gcLayout, getGcConfig('build-replay-gc')));
            }

            return Promise.all(tasks).then(() => {
                attachLegendVisibilityHandlers('single-rss');
                if (showGC) {
                    attachLegendVisibilityHandlers('single-gc');
                }
            });
        }

        function scheduleNext() {
            if (!isPlaying) return;
            if (currentFrame >= timestamps.length - 1) {
                isPlaying = false;
                return;
            }
            const nextDelay = Math.max(
                16,
                (timestamps[currentFrame + 1] - timestamps[currentFrame]) / speedMultiplier
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
