(function (global) {
    const COLOR_PALETTE = [
        '#3498db',
        '#e74c3c',
        '#9b59b6',
        '#2ecc71',
        '#f39c12',
        '#e67e22',
        '#1abc9c',
        '#e91e63'
    ];

    const visibilityStore = {};

    function applyVisibilityToTraces(chartId, traces) {
        const map = visibilityStore[chartId];
        if (!map) return traces;
        traces.forEach(trace => {
            if (trace && trace.name && map[trace.name] !== undefined) {
                trace.visible = map[trace.name];
            }
        });
        return traces;
    }

    function attachLegendVisibilityHandlers(chartId, onUpdate) {
        const chart = document.getElementById(chartId);
        if (!chart || chart.__visibilityHandlersAttached) return;
        chart.on('plotly_restyle', (eventData) => {
            const update = eventData[0];
            const indices = eventData[1];
            if (!update || update.visible === undefined) return;
            const vis = update.visible;
            const map = visibilityStore[chartId] || (visibilityStore[chartId] = {});
            indices.forEach((traceIndex, idx) => {
                const trace = chart.data && chart.data[traceIndex];
                if (!trace || !trace.name) return;
                map[trace.name] = Array.isArray(vis) ? vis[idx] : vis;
            });
            if (typeof onUpdate === 'function') {
                onUpdate();
            }
        });
        chart.__visibilityHandlersAttached = true;
    }

    function hasGCData(samples) {
        return samples.some(sample => {
            if (sample.GCTimeSeconds !== undefined && sample.GCTimeSeconds !== null) {
                return !Number.isNaN(sample.GCTimeSeconds);
            }
            return sample.GCTime !== undefined && sample.GCTime !== null && !Number.isNaN(sample.GCTime);
        });
    }

    function hasRatioData(samples) {
        return samples.some(sample => sample && sample.RSS && sample.RSS > 0);
    }

    function buildColorMap(processKeys, palette = COLOR_PALETTE) {
        const colorMap = {};
        processKeys.forEach((processKey, index) => {
            colorMap[processKey] = palette[index % palette.length];
        });
        return colorMap;
    }

    function getMedianDelta(timestamps) {
        if (!timestamps || timestamps.length < 2) return 0;
        const deltas = [];
        for (let i = 1; i < timestamps.length; i += 1) {
            deltas.push(timestamps[i] - timestamps[i - 1]);
        }
        deltas.sort((a, b) => a - b);
        const mid = Math.floor(deltas.length / 2);
        return deltas.length % 2 === 0 ? (deltas[mid - 1] + deltas[mid]) / 2 : deltas[mid];
    }

    function buildTotalRssSeries(samples, timestamps, processKeys) {
        const lastKnown = {};
        const lastSeen = {};
        const cursors = {};
        const perProcessSamples = {};

        processKeys.forEach(processKey => {
            lastKnown[processKey] = 0;
            lastSeen[processKey] = 0;
            cursors[processKey] = 0;
            const [processName, pid] = processKey.split('|');
            perProcessSamples[processKey] = samples
                .filter(s => s.Name === processName && s.PID === pid)
                .sort((a, b) => a.Timestamp - b.Timestamp);
        });

        const medianDelta = getMedianDelta(timestamps);
        const maxGap = medianDelta ? medianDelta * 2 : 0;
        const totalRss = [];
        const distribution = [];

        timestamps.forEach(timestamp => {
            let total = 0;
            const included = {};

            processKeys.forEach(processKey => {
                const list = perProcessSamples[processKey];
                let cursor = cursors[processKey];
                while (cursor < list.length && list[cursor].Timestamp <= timestamp) {
                    const sample = list[cursor];
                    if (sample.RSS && sample.RSS > 0) {
                        lastKnown[processKey] = sample.RSS;
                    } else {
                        lastKnown[processKey] = 0;
                    }
                    lastSeen[processKey] = sample.Timestamp;
                    cursor += 1;
                }
                cursors[processKey] = cursor;

                const recentlySeen = maxGap > 0 && lastSeen[processKey] > 0 && (timestamp - lastSeen[processKey]) <= maxGap;
                if (lastKnown[processKey] > 0 && (recentlySeen || lastSeen[processKey] === timestamp)) {
                    total += lastKnown[processKey];
                    included[processKey] = lastKnown[processKey];
                }
            });

            totalRss.push(total > 0 ? total : null);

            if (total <= 0) {
                distribution.push('No data');
            } else {
                const lines = [];
                processKeys.forEach(processKey => {
                    const rss = included[processKey];
                    if (!rss) return;
                    const [processName, pid] = processKey.split('|');
                    const percent = ((rss / total) * 100).toFixed(1);
                    lines.push(`${processName} PID:${pid}: ${percent}%`);
                });
                distribution.push(lines.join('<br>'));
            }
        });

        return { totalRss, distribution };
    }

    function buildForwardFilledSeries(samples, timestamps, processName, pid, valueSelector, maxGapOverride) {
        const filtered = samples
            .filter(s => s.Name === processName && s.PID === pid)
            .sort((a, b) => a.Timestamp - b.Timestamp);
        const values = [];
        let idx = 0;
        let lastValue = null;
        let lastSeen = 0;
        const medianDelta = getMedianDelta(timestamps);
        const maxGap = maxGapOverride !== undefined ? maxGapOverride : (medianDelta ? medianDelta * 2 : 0);

        for (const timestamp of timestamps) {
            while (idx < filtered.length && filtered[idx].Timestamp <= timestamp) {
                const candidate = valueSelector(filtered[idx]);
                if (candidate !== null && candidate !== undefined) {
                    lastValue = candidate;
                }
                lastSeen = filtered[idx].Timestamp;
                idx += 1;
            }

            if (maxGap > 0 && lastSeen > 0 && (timestamp - lastSeen) > maxGap) {
                lastValue = null;
            }

            values.push(lastValue);
        }
        return values;
    }

    function buildExactSeries(samples, timestamps, processName, pid, valueSelector) {
        const byTimestamp = new Map();
        samples.forEach(sample => {
            if (sample.Name === processName && sample.PID === pid) {
                byTimestamp.set(sample.Timestamp, valueSelector(sample));
            }
        });
        return timestamps.map(timestamp => {
            const value = byTimestamp.get(timestamp);
            return value === undefined ? null : value;
        });
    }

    function buildReplayData(samples, timestamps, palette = COLOR_PALETTE) {
        const processKeys = [...new Set(samples.map(s => `${s.Name}|${s.PID}`))];
        const colorMap = buildColorMap(processKeys, palette);
        const series = {};

        processKeys.forEach(processKey => {
            const [processName, pid] = processKey.split('|');
            const rss = buildForwardFilledSeries(samples, timestamps, processName, pid, s => s.RSS);
            const heap = buildForwardFilledSeries(samples, timestamps, processName, pid, s => s.HeapUsed);
            const gc = buildForwardFilledSeries(samples, timestamps, processName, pid, s => {
                const gcSeconds = s.GCTimeSeconds ?? (s.GCTime !== null && s.GCTime !== undefined && !Number.isNaN(s.GCTime)
                    ? s.GCTime / 1000
                    : null);
                return gcSeconds === null || Number.isNaN(gcSeconds) ? null : gcSeconds;
            }, Number.POSITIVE_INFINITY);
            const ratio = buildExactSeries(samples, timestamps, processName, pid, s => {
                if (!s.RSS || s.RSS <= 0) return null;
                return s.HeapUsed / s.RSS;
            });

            series[processKey] = {
                processName,
                pid,
                color: colorMap[processKey],
                rss,
                heap,
                gc,
                ratio,
                firstRss: rss.findIndex(value => value !== null),
                firstGc: gc.findIndex(value => value !== null),
                firstRatio: ratio.findIndex(value => value !== null)
            };
        });

        const totalSeries = buildTotalRssSeries(samples, timestamps, processKeys);

        return {
            processKeys,
            series,
            totalRss: totalSeries.totalRss,
            totalRssDistribution: totalSeries.distribution,
            firstTotalRssIndex: totalSeries.totalRss.findIndex(value => value !== null)
        };
    }

    function buildMetricTraces(data, timestamps, frameIndex, metric, style, xValues) {
        const lineWidth = style?.lineWidth ?? 3;
        const heapLineWidth = style?.heapLineWidth ?? 2;
        const markerSize = style?.markerSize ?? 6;
        const heapDash = style?.heapDash ?? 'dash';
        const lineDash = style?.lineDash ?? 'solid';
        const lineOpacity = style?.lineOpacity ?? 1;
        const markerOpacity = style?.markerOpacity ?? 1;
        const includeTotalRss = style?.includeTotalRss ?? false;
        const totalLabel = style?.totalLabel ?? 'Total RSS Memory';
        const totalColor = style?.totalColor ?? '#2c3e50';
        const frameTimestamps = xValues
            ? xValues.slice(0, frameIndex + 1)
            : timestamps.slice(0, frameIndex + 1).map(t => new Date(t));
        const traces = [];
        data.processKeys.forEach(processKey => {
            const def = data.series[processKey];
            const firstIndex = metric === 'gc' ? def.firstGc : metric === 'ratio' ? def.firstRatio : def.firstRss;
            if (firstIndex === -1 || frameIndex < firstIndex) return;
            if (metric === 'rss') {
                traces.push({
                    x: frameTimestamps,
                    y: def.rss.slice(0, frameIndex + 1),
                    type: 'scatter',
                    mode: 'lines',
                    name: `${def.processName} PID:${def.pid} (RSS)`,
                    line: { color: def.color, width: lineWidth, dash: lineDash },
                    opacity: lineOpacity,
                    connectgaps: false
                });
                traces.push({
                    x: frameTimestamps,
                    y: def.heap.slice(0, frameIndex + 1),
                    type: 'scatter',
                    mode: 'lines',
                    name: `${def.processName} PID:${def.pid} (Heap)`,
                    line: { color: def.color, width: heapLineWidth, dash: heapDash },
                    opacity: lineOpacity,
                    connectgaps: false
                });
                return;
            }
            traces.push({
                x: frameTimestamps,
                y: metric === 'gc' ? def.gc.slice(0, frameIndex + 1) : def.ratio.slice(0, frameIndex + 1),
                type: 'scatter',
                mode: 'lines+markers',
                name: `${def.processName} PID:${def.pid}`,
                line: { color: def.color, width: lineWidth, dash: lineDash },
                marker: { size: markerSize, color: def.color, opacity: markerOpacity },
                opacity: lineOpacity,
                connectgaps: false
            });
        });

        if (metric === 'rss' && includeTotalRss && data.totalRss) {
            const firstIndex = data.firstTotalRssIndex ?? -1;
            if (firstIndex !== -1 && frameIndex >= firstIndex) {
                traces.push({
                    x: frameTimestamps,
                    y: data.totalRss.slice(0, frameIndex + 1),
                    type: 'scatter',
                    mode: 'lines',
                    name: totalLabel,
                    line: { color: totalColor, width: lineWidth + 1, dash: lineDash },
                    opacity: lineOpacity,
                    connectgaps: false,
                    customdata: data.totalRssDistribution ? data.totalRssDistribution.slice(0, frameIndex + 1) : [],
                    hovertemplate: 'Total RSS: %{y} MB<br>%{customdata}<extra></extra>'
                });
            }
        }
        return traces;
    }

    function parseCsvText(text) {
        const lines = text.trim().split('\n');
        if (lines.length < 2) return [];
        const headers = lines[0].split(',').map(h => h.trim());
        const headerIndex = {};
        headers.forEach((header, index) => {
            headerIndex[header] = index;
        });

        const parsed = lines.slice(1).map(line => {
            const values = line.split(',');
            const get = (key) => {
                const index = headerIndex[key];
                return index === undefined ? '' : values[index];
            };
            const timestamp = Number(get('timestamp'));
            const elapsed = Number(get('elapsed_time'));
            const gcRaw = get('gc_time_s');
            const gcValue = gcRaw !== '' ? Number(gcRaw) : null;
            return {
                Timestamp: Number.isNaN(timestamp) ? 0 : timestamp,
                ElapsedTime: Number.isNaN(elapsed) ? 0 : elapsed,
                PID: get('pid'),
                Name: get('name'),
                RSS: Number(get('rss_mb')) || 0,
                HeapUsed: Number(get('heap_used_mb')) || 0,
                HeapCap: Number(get('heap_capacity_mb')) || 0,
                GCTime: gcValue !== null && !Number.isNaN(gcValue) ? gcValue * 1000 : null,
                GCTimeSeconds: gcValue !== null && !Number.isNaN(gcValue) ? gcValue : null
            };
        });
        return parsed;
    }

    function normalizeCompareSamples(samples, baseTimestamp) {
        if (!samples.length || !baseTimestamp) return [];
        return samples.map(sample => {
            const elapsedMs = (sample.ElapsedTime || 0) * 1000;
            const timestamp = baseTimestamp + elapsedMs;
            return {
                ...sample,
                Timestamp: timestamp
            };
        });
    }

    function getGcLayout() {
        const isMobile = window.innerWidth < 768;
        return {
            title: isMobile ? '' : 'Garbage Collection Time Over Time',
            xaxis: {
                title: 'Time',
                tickformat: isMobile ? '%H:%M' : '%H:%M:%S',
                tickangle: isMobile ? -45 : 0
            },
            yaxis: { title: 'GC Time (s)' },
            showlegend: true,
            legend: {
                x: isMobile ? 0.5 : 1.02,
                y: isMobile ? -0.2 : 1,
                xanchor: isMobile ? 'center' : 'left',
                orientation: isMobile ? 'h' : 'v'
            },
            margin: {
                l: isMobile ? 50 : 60,
                r: isMobile ? 20 : 100,
                t: isMobile ? 20 : 40,
                b: isMobile ? 80 : 60
            },
            font: {
                size: isMobile ? 10 : 12
            }
        };
    }

    function getGcConfig(filenameBase = 'build-monitor-gc') {
        const isMobile = window.innerWidth < 768;
        return {
            responsive: true,
            displayModeBar: true,
            displaylogo: false,
            modeBarButtonsToRemove: ['pan2d', 'lasso2d', 'select2d', 'autoScale2d'],
            toImageButtonOptions: {
                format: 'png',
                filename: filenameBase,
                height: isMobile ? 400 : 500,
                width: isMobile ? 800 : 1000,
                scale: 2
            }
        };
    }

    function getRatioLayout() {
        const isMobile = window.innerWidth < 768;
        return {
            title: isMobile ? '' : 'Heap/RSS Ratio Over Time',
            xaxis: {
                title: 'Time',
                tickformat: isMobile ? '%H:%M' : '%H:%M:%S',
                tickangle: isMobile ? -45 : 0
            },
            yaxis: { title: 'Heap/RSS Ratio' },
            showlegend: true,
            legend: {
                x: isMobile ? 0.5 : 1.02,
                y: isMobile ? -0.2 : 1,
                xanchor: isMobile ? 'center' : 'left',
                orientation: isMobile ? 'h' : 'v'
            },
            margin: {
                l: isMobile ? 50 : 60,
                r: isMobile ? 20 : 100,
                t: isMobile ? 20 : 40,
                b: isMobile ? 80 : 60
            },
            font: {
                size: isMobile ? 10 : 12
            }
        };
    }

    function getRatioConfig(filenameBase = 'build-monitor-rss-heap') {
        const isMobile = window.innerWidth < 768;
        return {
            responsive: true,
            displayModeBar: true,
            displaylogo: false,
            modeBarButtonsToRemove: ['pan2d', 'lasso2d', 'select2d', 'autoScale2d'],
            toImageButtonOptions: {
                format: 'png',
                filename: filenameBase,
                height: isMobile ? 400 : 500,
                width: isMobile ? 800 : 1000,
                scale: 2
            }
        };
    }

    function getMemoryLayout() {
        const isMobile = window.innerWidth < 768;
        return {
            title: isMobile ? '' : 'Memory Usage Over Time',
            xaxis: {
                title: 'Time',
                tickformat: isMobile ? '%H:%M' : '%H:%M:%S',
                tickangle: isMobile ? -45 : 0
            },
            yaxis: { title: 'Memory (MB)' },
            showlegend: true,
            legend: {
                x: isMobile ? 0.5 : 1.02,
                y: isMobile ? -0.2 : 1,
                xanchor: isMobile ? 'center' : 'left',
                orientation: isMobile ? 'h' : 'v'
            },
            margin: {
                l: isMobile ? 50 : 60,
                r: isMobile ? 20 : 100,
                t: isMobile ? 20 : 40,
                b: isMobile ? 80 : 60
            },
            font: {
                size: isMobile ? 10 : 12
            }
        };
    }

    function getMemoryConfig(filenameBase = 'build-monitor') {
        const isMobile = window.innerWidth < 768;
        return {
            responsive: true,
            displayModeBar: true,
            displaylogo: false,
            modeBarButtonsToRemove: ['pan2d', 'lasso2d', 'select2d', 'autoScale2d'],
            toImageButtonOptions: {
                format: 'png',
                filename: filenameBase,
                height: isMobile ? 400 : 500,
                width: isMobile ? 800 : 1000,
                scale: 2
            }
        };
    }

    function renderCompareSection(options) {
        const {
            baseSamples = [],
            compareSamplesRaw = [],
            compareSectionId = 'compare-section',
            compareModeStorageKey = 'compareMode',
            baseLabel = 'Current Run',
            compareLabel = 'Comparison Run',
            headerTitle = 'Comparison',
            headerSubtitle = 'Replay both builds with a shared timeline',
            memoryFilenameBase,
            gcFilenameBase,
            ratioFilenameBase
        } = options || {};

        const compareSection = typeof compareSectionId === 'string'
            ? document.getElementById(compareSectionId)
            : compareSectionId;
        if (!compareSection) return;
        if (!Array.isArray(compareSamplesRaw) || !compareSamplesRaw.length) {
            compareSection.style.display = 'none';
            compareSection.innerHTML = '';
            return;
        }

        const timestamps = [...new Set(baseSamples.map(s => s.Timestamp))].sort((a, b) => a - b);
        const compareSamples = normalizeCompareSamples(compareSamplesRaw, timestamps[0]);
        const baseHasGC = hasGCData(baseSamples);
        const compareHasGC = hasGCData(compareSamples);
        const baseHasRatio = hasRatioData(baseSamples);
        const compareHasRatio = hasRatioData(compareSamples);
        const showGC = baseHasGC && compareHasGC;
        const showRatio = baseHasRatio && compareHasRatio;

        const storedMode = localStorage.getItem(compareModeStorageKey) || 'split';
        const compareMode = storedMode === 'side' ? 'side' : 'split';
        const isSplitMode = compareMode === 'split';
        const splitLabel = `${baseLabel} vs ${compareLabel} (Split View)`;

        compareSection.innerHTML = `
            <div class="compare-header">
                <h2>${headerTitle}</h2>
                <span class="meta">${headerSubtitle}</span>
                <label class="meta" style="display:flex; align-items:center; gap:0.5rem;">
                    View:
                    <select id="compare-view-mode">
                        <option value="split" ${isSplitMode ? 'selected' : ''}>Split View</option>
                        <option value="side" ${!isSplitMode ? 'selected' : ''}>Side by Side</option>
                    </select>
                </label>
            </div>
            <div class="replay-controls" id="compare-replay-controls">
                <div class="buttons">
                    <button class="btn" id="btn-compare-replay-play">Play</button>
                    <button class="btn secondary" id="btn-compare-replay-pause">Pause</button>
                    <button class="btn secondary" id="btn-compare-replay-reset">Reset</button>
                </div>
                <div class="meta" id="compare-replay-meta">Frame 0 / 0</div>
                <div class="timeline">
                    <input type="range" id="compare-replay-timeline" min="0" max="0" value="0">
                    <div class="meta" id="compare-replay-time-label">Elapsed: 0s</div>
                    <div class="meta">
                        Speed:
                        <select id="compare-replay-speed">
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
            <div class="compare-grid">
                ${isSplitMode ? `
                <div class="compare-column">
                    <h3>${splitLabel}</h3>
                    <div class="chart-container">
                        <h4>Memory Usage Over Time</h4>
                        <div class="chart-wrapper">
                            <div id="compare-rss" style="width: 100%; height: 460px;"></div>
                        </div>
                    </div>
                    ${showGC ? `
                    <div class="chart-container">
                        <h4>Garbage Collection Time Over Time</h4>
                        <div class="chart-wrapper">
                            <div id="compare-gc" style="width: 100%; height: 460px;"></div>
                        </div>
                    </div>
                    ` : ''}
                    ${showRatio ? `
                    <div class="chart-container">
                        <h4>Heap/RSS Ratio Over Time</h4>
                        <div class="chart-wrapper">
                            <div id="compare-ratio" style="width: 100%; height: 460px;"></div>
                        </div>
                    </div>
                    ` : ''}
                </div>
                ` : `
                <div class="compare-column">
                    <h3>${baseLabel}</h3>
                    <div class="chart-container">
                        <h4>Memory Usage Over Time</h4>
                        <div class="chart-wrapper">
                            <div id="compare-current-rss" style="width: 100%; height: 460px;"></div>
                        </div>
                    </div>
                    ${showGC ? `
                    <div class="chart-container">
                        <h4>Garbage Collection Time Over Time</h4>
                        <div class="chart-wrapper">
                            <div id="compare-current-gc" style="width: 100%; height: 460px;"></div>
                        </div>
                    </div>
                    ` : ''}
                    ${showRatio ? `
                    <div class="chart-container">
                        <h4>Heap/RSS Ratio Over Time</h4>
                        <div class="chart-wrapper">
                            <div id="compare-current-ratio" style="width: 100%; height: 460px;"></div>
                        </div>
                    </div>
                    ` : ''}
                </div>
                <div class="compare-column">
                    <h3>${compareLabel}</h3>
                    <div class="chart-container">
                        <h4>Memory Usage Over Time</h4>
                        <div class="chart-wrapper">
                            <div id="compare-other-rss" style="width: 100%; height: 460px;"></div>
                        </div>
                    </div>
                    ${showGC ? `
                    <div class="chart-container">
                        <h4>Garbage Collection Time Over Time</h4>
                        <div class="chart-wrapper">
                            <div id="compare-other-gc" style="width: 100%; height: 460px;"></div>
                        </div>
                    </div>
                    ` : ''}
                    ${showRatio ? `
                    <div class="chart-container">
                        <h4>Heap/RSS Ratio Over Time</h4>
                        <div class="chart-wrapper">
                            <div id="compare-other-ratio" style="width: 100%; height: 460px;"></div>
                        </div>
                    </div>
                    ` : ''}
                </div>
                `}
            </div>
        `;

        compareSection.style.display = 'block';

        const elapsedSeconds = timestamps.map(ts => Math.max(0, (ts - timestamps[0]) / 1000));
        const maxElapsed = elapsedSeconds.length ? elapsedSeconds[elapsedSeconds.length - 1] : 0;
        const compareElapsed = elapsedSeconds.map(value => value + maxElapsed);
        const baseData = buildReplayData(baseSamples, timestamps, COLOR_PALETTE);
        const compareData = buildReplayData(compareSamples, timestamps, COLOR_PALETTE);

        const sharedProcessNames = [...new Set([
            ...baseSamples.map(s => s.Name),
            ...compareSamples.map(s => s.Name)
        ])];
        const sharedColorMap = buildColorMap(sharedProcessNames, COLOR_PALETTE);
        [baseData, compareData].forEach(data => {
            data.processKeys.forEach(processKey => {
                const def = data.series[processKey];
                def.color = sharedColorMap[def.processName] || def.color;
            });
        });

        const baseStyle = {
            lineWidth: 3,
            heapLineWidth: 2,
            markerSize: 6,
            lineDash: 'solid',
            heapDash: 'dash',
            lineOpacity: 1,
            markerOpacity: 1,
            includeTotalRss: true,
            totalLabel: 'Total RSS Memory',
            totalColor: '#2c3e50'
        };
        const compareStyle = {
            lineWidth: 4,
            heapLineWidth: 3,
            markerSize: 8,
            lineDash: 'solid',
            heapDash: 'dash',
            lineOpacity: 0.6,
            markerOpacity: 0.6,
            includeTotalRss: true,
            totalLabel: 'Compare Total RSS Memory',
            totalColor: '#0f172a'
        };

        const timeline = document.getElementById('compare-replay-timeline');
        const meta = document.getElementById('compare-replay-meta');
        const timeLabel = document.getElementById('compare-replay-time-label');
        const playBtn = document.getElementById('btn-compare-replay-play');
        const pauseBtn = document.getElementById('btn-compare-replay-pause');
        const resetBtn = document.getElementById('btn-compare-replay-reset');
        const speedSelect = document.getElementById('compare-replay-speed');

        let isPlaying = false;
        let playTimer = null;
        let currentFrame = 0;
        let speedMultiplier = Number(speedSelect.value) || 15;

        timeline.max = String(Math.max(0, timestamps.length - 1));

        const elapsedByTimestamp = new Map();
        baseSamples.forEach(sample => {
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
            const compareLayout = {
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
                },
                shapes: [
                    {
                        type: 'line',
                        x0: maxElapsed,
                        x1: maxElapsed,
                        y0: 0,
                        y1: 1,
                        xref: 'x',
                        yref: 'paper',
                        line: { color: '#94a3b8', width: 1, dash: 'dot' }
                    }
                ]
            };
            if (isSplitMode) {
                const rssTraces = [
                    ...buildMetricTraces(baseData, timestamps, frameIndex, 'rss', baseStyle, elapsedSeconds),
                    ...buildMetricTraces(compareData, timestamps, frameIndex, 'rss', compareStyle, compareElapsed)
                ];
                tasks.push(Plotly.react('compare-rss', applyVisibilityToTraces('compare-rss', rssTraces), compareLayout, getMemoryConfig(memoryFilenameBase)));
            } else {
                const sideLayout = {
                    ...compareLayout,
                    shapes: []
                };
                tasks.push(Plotly.react('compare-current-rss', applyVisibilityToTraces('compare-current-rss', buildMetricTraces(baseData, timestamps, frameIndex, 'rss', baseStyle, elapsedSeconds)), sideLayout, getMemoryConfig(memoryFilenameBase)));
                tasks.push(Plotly.react('compare-other-rss', applyVisibilityToTraces('compare-other-rss', buildMetricTraces(compareData, timestamps, frameIndex, 'rss', compareStyle, elapsedSeconds)), sideLayout, getMemoryConfig(memoryFilenameBase)));
            }
            if (showGC) {
                const compareGcLayout = {
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
                    },
                    shapes: [
                        {
                            type: 'line',
                            x0: maxElapsed,
                            x1: maxElapsed,
                            y0: 0,
                            y1: 1,
                            xref: 'x',
                            yref: 'paper',
                            line: { color: '#94a3b8', width: 1, dash: 'dot' }
                        }
                    ]
                };
                if (isSplitMode) {
                    const gcTraces = [
                        ...buildMetricTraces(baseData, timestamps, frameIndex, 'gc', baseStyle, elapsedSeconds),
                        ...buildMetricTraces(compareData, timestamps, frameIndex, 'gc', compareStyle, compareElapsed)
                    ];
                    tasks.push(Plotly.react('compare-gc', applyVisibilityToTraces('compare-gc', gcTraces), compareGcLayout, getGcConfig(gcFilenameBase)));
                } else {
                    const sideGcLayout = {
                        ...compareGcLayout,
                        shapes: []
                    };
                    tasks.push(Plotly.react('compare-current-gc', applyVisibilityToTraces('compare-current-gc', buildMetricTraces(baseData, timestamps, frameIndex, 'gc', baseStyle, elapsedSeconds)), sideGcLayout, getGcConfig(gcFilenameBase)));
                    tasks.push(Plotly.react('compare-other-gc', applyVisibilityToTraces('compare-other-gc', buildMetricTraces(compareData, timestamps, frameIndex, 'gc', compareStyle, compareElapsed)), sideGcLayout, getGcConfig(gcFilenameBase)));
                }
            }
            if (showRatio) {
                const compareRatioLayout = {
                    ...getRatioLayout(),
                    xaxis: {
                        ...getRatioLayout().xaxis,
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
                        ...getRatioLayout().margin,
                        b: 110
                    },
                    shapes: [
                        {
                            type: 'line',
                            x0: maxElapsed,
                            x1: maxElapsed,
                            y0: 0,
                            y1: 1,
                            xref: 'x',
                            yref: 'paper',
                            line: { color: '#94a3b8', width: 1, dash: 'dot' }
                        }
                    ]
                };
                if (isSplitMode) {
                    const ratioTraces = [
                        ...buildMetricTraces(baseData, timestamps, frameIndex, 'ratio', baseStyle, elapsedSeconds),
                        ...buildMetricTraces(compareData, timestamps, frameIndex, 'ratio', compareStyle, compareElapsed)
                    ];
                    tasks.push(Plotly.react('compare-ratio', applyVisibilityToTraces('compare-ratio', ratioTraces), compareRatioLayout, getRatioConfig(ratioFilenameBase)));
                } else {
                    const sideRatioLayout = {
                        ...compareRatioLayout,
                        shapes: []
                    };
                    tasks.push(Plotly.react('compare-current-ratio', applyVisibilityToTraces('compare-current-ratio', buildMetricTraces(baseData, timestamps, frameIndex, 'ratio', baseStyle, elapsedSeconds)), sideRatioLayout, getRatioConfig(ratioFilenameBase)));
                    tasks.push(Plotly.react('compare-other-ratio', applyVisibilityToTraces('compare-other-ratio', buildMetricTraces(compareData, timestamps, frameIndex, 'ratio', compareStyle, compareElapsed)), sideRatioLayout, getRatioConfig(ratioFilenameBase)));
                }
            }

            return Promise.all(tasks).then(() => {
                if (isSplitMode) {
                    attachLegendVisibilityHandlers('compare-rss');
                    if (showGC) {
                        attachLegendVisibilityHandlers('compare-gc');
                    }
                    if (showRatio) {
                        attachLegendVisibilityHandlers('compare-ratio');
                    }
                } else {
                    attachLegendVisibilityHandlers('compare-current-rss');
                    attachLegendVisibilityHandlers('compare-other-rss');
                    if (showGC) {
                        attachLegendVisibilityHandlers('compare-current-gc');
                        attachLegendVisibilityHandlers('compare-other-gc');
                    }
                    if (showRatio) {
                        attachLegendVisibilityHandlers('compare-current-ratio');
                        attachLegendVisibilityHandlers('compare-other-ratio');
                    }
                }
            });
        }

        function pause() {
            if (playTimer) clearTimeout(playTimer);
            playTimer = null;
            isPlaying = false;
        }

        function play() {
            if (isPlaying) return;
            isPlaying = true;
            const tick = () => {
                if (!isPlaying) return;
                const nextFrame = Math.min(currentFrame + 1, timestamps.length - 1);
                renderFrame(nextFrame);
                if (nextFrame >= timestamps.length - 1) {
                    pause();
                    return;
                }
                playTimer = setTimeout(tick, 1000 / speedMultiplier);
            };
            playTimer = setTimeout(tick, 1000 / speedMultiplier);
        }

        function reset() {
            pause();
            renderFrame(0);
        }

        timeline.addEventListener('input', event => {
            pause();
            const value = Number(event.target.value) || 0;
            renderFrame(value);
        });

        playBtn.addEventListener('click', play);
        pauseBtn.addEventListener('click', pause);
        resetBtn.addEventListener('click', reset);
        speedSelect.addEventListener('change', event => {
            speedMultiplier = Number(event.target.value) || 15;
        });

        if (!global.compareReplayStops) {
            global.compareReplayStops = {};
        }
        global.compareReplayStops.default = pause;

        renderFrame(0);

        const viewSelect = document.getElementById('compare-view-mode');
        if (viewSelect) {
            viewSelect.addEventListener('change', (event) => {
                const nextMode = event.target.value === 'side' ? 'side' : 'split';
                localStorage.setItem(compareModeStorageKey, nextMode);
                renderCompareSection({
                    baseSamples,
                    compareSamplesRaw,
                    compareSectionId,
                    compareModeStorageKey,
                    baseLabel,
                    compareLabel,
                    headerTitle,
                    headerSubtitle,
                    memoryFilenameBase,
                    gcFilenameBase,
                    ratioFilenameBase
                });
            });
        }
    }

    global.BpwCompareShared = {
        COLOR_PALETTE,
        visibilityStore,
        applyVisibilityToTraces,
        attachLegendVisibilityHandlers,
        hasGCData,
        hasRatioData,
        buildColorMap,
        getMedianDelta,
        buildTotalRssSeries,
        buildForwardFilledSeries,
        buildExactSeries,
        buildReplayData,
        buildMetricTraces,
        parseCsvText,
        normalizeCompareSamples,
        getGcLayout,
        getGcConfig,
        getRatioLayout,
        getRatioConfig,
        getMemoryLayout,
        getMemoryConfig,
        renderCompareSection
    };
})(window);
