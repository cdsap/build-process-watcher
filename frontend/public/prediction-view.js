(function () {
    'use strict';

    const RISK_LEVELS = ['low', 'elevated', 'high'];
    const STATUS_VALUES = ['ready', 'pending', 'skipped', 'error'];

    function finiteNumber(value) {
        if (value === null || value === undefined || value === '') return null;
        const number = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(number) ? number : null;
    }

    function presentNumber(value) {
        return value !== null && value !== undefined && value !== '' && finiteNumber(value) !== null;
    }

    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function normalizeCheckpoints(raw) {
        if (!Array.isArray(raw)) return [];
        const byWindow = new Map();
        raw.forEach((checkpoint) => {
            const windowSeconds = finiteNumber(checkpoint?.observation_window_s);
            if (windowSeconds === null || windowSeconds < 0) return;
            byWindow.set(windowSeconds, { ...checkpoint, observation_window_s: windowSeconds });
        });
        return [...byWindow.values()].sort((a, b) => a.observation_window_s - b.observation_window_s);
    }

    function statusOf(checkpoint) {
        return STATUS_VALUES.includes(checkpoint?.status) ? checkpoint.status : 'unknown';
    }

    function riskOf(checkpoint) {
        return RISK_LEVELS.includes(checkpoint?.risk_level) ? checkpoint.risk_level : 'unknown';
    }

    function formatElapsed(seconds) {
        const value = finiteNumber(seconds);
        if (value === null || value < 0) return 'Not available';
        const rounded = Math.round(value);
        if (rounded < 60) return `${rounded}s`;
        const minutes = Math.floor(rounded / 60);
        const remainder = rounded % 60;
        return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
    }

    function formatValue(value, unit) {
        const number = finiteNumber(value);
        if (number === null) return 'Not available';
        return `${number.toFixed(Math.abs(number) >= 1000 ? 0 : 1)} ${unit}`;
    }

    function formatDelta(value, unit) {
        const number = finiteNumber(value);
        if (number === null) return '';
        const sign = number > 0 ? '+' : '';
        return `${sign}${number.toFixed(Math.abs(number) >= 1000 ? 0 : 1)} ${unit}`;
    }

    function latestReady(checkpoints) {
        return [...checkpoints].reverse().find(checkpoint => statusOf(checkpoint) === 'ready') || null;
    }

    function selectCheckpoint(checkpoints, selectedWindow) {
        const selected = checkpoints.find(checkpoint => checkpoint.observation_window_s === selectedWindow);
        return selected || latestReady(checkpoints) || checkpoints[checkpoints.length - 1] || null;
    }

    function formatMarkerValue(value, unit) {
        const number = Number(value);
        return Number.isFinite(number) ? `${number.toFixed(number >= 1000 ? 0 : 1)} ${unit}` : 'N/A';
    }

    function markerColor(checkpoint) {
        if ((checkpoint?.status || 'unknown') !== 'ready') return '#94a3b8';
        return {
            low: '#16a34a',
            elevated: '#d97706',
            high: '#dc2626',
            unknown: '#64748b'
        }[riskOf(checkpoint)] || '#64748b';
    }

    function markerHoverText(checkpoint) {
        const bits = [
            `Window: ${escapeHtml(String(checkpoint?.observation_window_s || 'N/A'))}s`,
            `Status: ${escapeHtml(checkpoint?.status || 'unknown')}`,
            `Risk: ${escapeHtml(checkpoint?.risk_level || 'unknown')}`
        ];
        if (checkpoint?.confidence) bits.push(`Confidence: ${escapeHtml(checkpoint.confidence)}`);
        if (Number.isFinite(Number(checkpoint?.predicted_peak_rss_mb))) bits.push(`Predicted peak RSS: ${formatMarkerValue(checkpoint.predicted_peak_rss_mb, 'MB')}`);
        if (Number.isFinite(Number(checkpoint?.predicted_duration_s))) bits.push(`Predicted duration: ${formatMarkerValue(checkpoint.predicted_duration_s, 's')}`);
        if (Array.isArray(checkpoint?.signals) && checkpoint.signals.length) {
            bits.push(`Top signals: ${checkpoint.signals.slice(0, 3).map(signal => escapeHtml(signal)).join(', ')}`);
        }
        return bits.join('<br>');
    }

    function buildMarkerData(checkpoints, timestamps, options = {}) {
        if (!Array.isArray(checkpoints) || !checkpoints.length || !Array.isArray(timestamps) || !timestamps.length) {
            return { shapes: [], annotations: [], traces: [] };
        }
        const firstTimestamp = Number(timestamps[0]);
        const elapsedAxis = options.axisMode === 'elapsed';
        if (!elapsedAxis && !Number.isFinite(firstTimestamp)) {
            return { shapes: [], annotations: [], traces: [] };
        }
        const markers = checkpoints
            .map(checkpoint => {
                const windowSeconds = Number(checkpoint?.observation_window_s);
                if (!Number.isFinite(windowSeconds) || windowSeconds < 0) return null;
                const status = checkpoint.status || 'unknown';
                const ready = status === 'ready';
                const color = markerColor(checkpoint);
                return {
                    checkpoint,
                    windowSeconds,
                    status,
                    ready,
                    color,
                    x: elapsedAxis ? windowSeconds : new Date(firstTimestamp + windowSeconds * 1000),
                    label: ready ? `P ${windowSeconds}s` : `${status} ${windowSeconds}s`
                };
            })
            .filter(Boolean);
        if (!markers.length) return { shapes: [], annotations: [], traces: [] };
        return {
            shapes: markers.map(marker => ({
                type: 'line',
                xref: 'x',
                yref: 'paper',
                x0: marker.x,
                x1: marker.x,
                y0: 0,
                y1: 1,
                line: { color: marker.color, width: marker.ready ? 2 : 1, dash: 'dot' },
                opacity: marker.ready ? 0.85 : 0.45
            })),
            annotations: markers.map(marker => ({
                x: marker.x,
                y: 1.02,
                xref: 'x',
                yref: 'paper',
                text: escapeHtml(marker.label),
                showarrow: false,
                font: { size: 11, color: marker.color },
                bgcolor: 'rgba(255,255,255,0.86)',
                bordercolor: marker.color,
                borderwidth: 1,
                borderpad: 2
            })),
            traces: [{
                x: markers.map(marker => marker.x),
                y: markers.map(() => 0.98),
                yaxis: 'y2',
                type: 'scatter',
                mode: 'markers',
                name: 'Prediction checkpoints',
                marker: {
                    symbol: 'triangle-down',
                    size: markers.map(marker => marker.ready ? 12 : 10),
                    color: markers.map(marker => marker.color),
                    line: { color: '#ffffff', width: 1 }
                },
                text: markers.map(marker => markerHoverText(marker.checkpoint)),
                hoverinfo: 'text',
                hovertemplate: '%{text}<extra>Prediction checkpoint</extra>',
                customdata: markers.map(marker => marker.windowSeconds),
                showlegend: true
            }]
        };
    }

    function observedAtCheckpoint(samples, checkpoint) {
        if (!Array.isArray(samples) || !samples.length || !checkpoint) return null;
        const usable = samples.filter(sample => finiteNumber(sample?.Timestamp) !== null && finiteNumber(sample?.RSS) !== null);
        if (!usable.length) return null;
        const firstTimestamp = Math.min(...usable.map(sample => Number(sample.Timestamp)));
        const cutoff = firstTimestamp + checkpoint.observation_window_s * 1000;
        const timestamps = [...new Set(usable
            .filter(sample => Number(sample.Timestamp) <= cutoff)
            .map(sample => Number(sample.Timestamp)))].sort((a, b) => a - b);
        if (!timestamps.length) return null;
        const timestamp = timestamps[timestamps.length - 1];
        const rss = aggregateRssAtTimestamp(usable, timestamp);
        return { timestamp, rss };
    }

    function aggregateRssAtTimestamp(samples, timestamp) {
        const usable = Array.isArray(samples)
            ? samples.filter(sample => finiteNumber(sample?.Timestamp) !== null && finiteNumber(sample?.RSS) !== null)
            : [];
        if (!usable.length || finiteNumber(timestamp) === null) return null;
        const latestByProcess = new Map();
        usable
            .filter(sample => Number(sample.Timestamp) <= Number(timestamp))
            .sort((a, b) => Number(a.Timestamp) - Number(b.Timestamp))
            .forEach(sample => {
                const processKey = `${sample?.Name ?? ''}|${sample?.PID ?? ''}`;
                latestByProcess.set(processKey, Number(sample.RSS));
            });
        if (!latestByProcess.size) return null;
        return [...latestByProcess.values()].reduce((total, rss) => total + rss, 0);
    }

    function peakAggregateRss(samples) {
        if (!Array.isArray(samples)) return null;
        const timestamps = [...new Set(samples
            .map(sample => finiteNumber(sample?.Timestamp))
            .filter(timestamp => timestamp !== null))].sort((a, b) => a - b);
        if (!timestamps.length) return null;
        const aggregates = timestamps.map(timestamp => aggregateRssAtTimestamp(samples, timestamp)).filter(value => value !== null);
        return aggregates.length ? Math.max(...aggregates) : null;
    }

    function evolution(checkpoints, field, unit) {
        let previous = null;
        return checkpoints.map((checkpoint) => {
            const value = presentNumber(checkpoint[field]) ? finiteNumber(checkpoint[field]) : null;
            const delta = value !== null && previous !== null ? formatDelta(value - previous, unit) : '';
            if (value !== null) previous = value;
            return { checkpoint, value, delta };
        });
    }

    function renderMetricRow(label, rows, unit) {
        const values = rows.filter(row => row.value !== null);
        if (!values.length) return '';
        return `<div class="prediction-evolution-row"><div><strong>${label}</strong><span>At each evaluation</span></div><div class="prediction-evolution-values">${values.map(row => `<button type="button" class="prediction-evolution-value" data-prediction-window="${row.checkpoint.observation_window_s}"><span>${formatElapsed(row.checkpoint.observation_window_s)}</span><strong>${formatValue(row.value, unit)}</strong>${row.delta ? `<em>${escapeHtml(row.delta)}</em>` : ''}</button>`).join('')}</div></div>`;
    }

    // Match an observed sample near a forecast target. Sparse monitor samples almost
    // never land on exact target millis, so allow a ±10s window on the sample clock.
    const ACTUAL_MATCH_WINDOW_MS = 10000;

    function actualNear(actuals, targetMs, maxDeltaMs) {
        const target = finiteNumber(targetMs);
        const windowMs = finiteNumber(maxDeltaMs);
        if (target === null || windowMs === null || windowMs < 0 || !Array.isArray(actuals) || !actuals.length) return null;
        let best = null;
        actuals.forEach((sample) => {
            const time = finiteNumber(sample?.time);
            const value = finiteNumber(sample?.value);
            if (time === null || value === null || value < 0) return;
            const delta = Math.abs(time - target);
            if (delta > windowMs) return;
            if (
                !best
                || delta < best.delta
                || (delta === best.delta && time <= target && best.time > target)
            ) {
                best = { time, value, delta };
            }
        });
        return best;
    }

    function niceTicks(min, max, count) {
        if (!(max > min) || count < 2) return [min, max];
        const span = max - min;
        const step = span / (count - 1);
        const ticks = [];
        for (let i = 0; i < count; i += 1) ticks.push(min + step * i);
        return ticks;
    }

    function predictionPath(prediction, actuals) {
        const origin = actualNear(actuals, prediction.created, ACTUAL_MATCH_WINDOW_MS);
        const start = origin
            ? { time: origin.time, value: origin.value }
            : { time: prediction.created, value: prediction.points[0].value };
        return [start].concat(prediction.points);
    }

    function collectForecastGroups(data) {
        const samples = Array.isArray(data?.samples) ? data.samples : [];
        const forecasts = Array.isArray(data?.process_forecasts) ? data.process_forecasts : [];
        const groups = new Map();
        samples.forEach(sample => {
            if (!/^(GradleDaemon|GradleWorkerMain|KotlinCompileDaemon)$/.test(sample?.Name || '') || sample.PID == null) return;
            const timestamp = finiteNumber(sample.Timestamp);
            if (timestamp === null || !Number.isFinite(new Date(timestamp).getTime())) return;
            ['heap', 'rss'].forEach(metric => {
                const value = finiteNumber(sample[metric === 'heap' ? 'HeapUsed' : 'RSS']);
                if (value === null || value < 0) return;
                const key = JSON.stringify([sample.Name, String(sample.PID), metric]);
                if (!groups.has(key)) groups.set(key, { name: sample.Name, pid: String(sample.PID), metric, actual: [], predictions: [] });
                groups.get(key).actual.push({ time: timestamp, value });
            });
        });
        forecasts.forEach(forecast => {
            const key = JSON.stringify([forecast?.process_name, String(forecast?.pid), forecast?.metric]);
            const group = groups.get(key);
            const created = finiteNumber(forecast?.created_at_ms);
            if (!group || created === null || !Number.isFinite(new Date(created).getTime()) || !Array.isArray(forecast.points)) return;
            const points = forecast.points.map(point => ({ time: finiteNumber(point?.target_at_ms), value: finiteNumber(point?.value_mb) }))
                .filter(point => point.time !== null && Number.isFinite(new Date(point.time).getTime()) && point.time >= created && point.value !== null && point.value >= 0)
                .sort((a, b) => a.time - b.time);
            if (points.length) group.predictions.push({ created, points });
        });
        return [...groups.values()].filter(group => group.predictions.length).map((group) => {
            group.actual.sort((a, b) => a.time - b.time);
            // Keep one issuance per created_at so duplicate provider writes do not stack.
            const byCreated = new Map();
            group.predictions
                .sort((a, b) => a.created - b.created)
                .forEach((prediction) => { byCreated.set(prediction.created, prediction); });
            group.predictions = [...byCreated.values()];
            return group;
        });
    }

    // Draw each issuance as its own path (anchor at nearest actual + forecast targets).
    // Replay reveals issuances when created_at passes and scrubs the actual series.
    function renderForecastChartSvg(group, untilMs) {
        const issuancePaths = group.predictions.map((prediction) => ({
            created: prediction.created,
            path: predictionPath(prediction, group.actual),
        })).filter((item) => item.path.length >= 2);
        const allPredictionPoints = issuancePaths.flatMap((item) => item.path);
        const allValues = group.actual.map((point) => point.value)
            .concat(allPredictionPoints.map((point) => point.value));
        const minTime = Math.min(
            group.actual[0].time,
            ...allPredictionPoints.map((point) => point.time),
        );
        const maxTime = Math.max(
            group.actual[group.actual.length - 1].time,
            ...allPredictionPoints.map((point) => point.time),
        );
        const minValue = Math.min(...allValues);
        const maxValue = Math.max(...allValues, 1);
        const valuePad = Math.max((maxValue - minValue) * 0.08, maxValue * 0.04, 1);
        const yMin = Math.max(0, minValue - valuePad);
        const yMax = maxValue + valuePad;
        const plot = { left: 54, right: 586, top: 18, bottom: 148 };
        const xAt = time => plot.left + (plot.right - plot.left) * (time - minTime) / (maxTime - minTime || 1);
        const yAt = value => plot.bottom - (plot.bottom - plot.top) * (value - yMin) / (yMax - yMin || 1);
        const xy = point => `${xAt(point.time)},${yAt(point.value)}`;
        const elapsedS = time => (time - minTime) / 1000;
        const xTicks = niceTicks(minTime, maxTime, 5);
        const yTicks = niceTicks(yMin, yMax, 5);
        const grid = yTicks.map((value) => `<line class="chart-grid" x1="${plot.left}" x2="${plot.right}" y1="${yAt(value)}" y2="${yAt(value)}"/>`).join('')
            + xTicks.map((time) => `<line class="chart-grid" x1="${xAt(time)}" x2="${xAt(time)}" y1="${plot.top}" y2="${plot.bottom}"/>`).join('');
        const xLabels = xTicks.map((time) => `<text class="chart-tick" x="${xAt(time)}" y="${plot.bottom + 16}" text-anchor="middle">${Math.round(elapsedS(time))}s</text>`).join('');
        const yLabels = yTicks.map((value) => `<text class="chart-tick" x="${plot.left - 8}" y="${yAt(value) + 3}" text-anchor="end">${Math.round(value)}</text>`).join('');

        const cutoff = finiteNumber(untilMs);
        const visibleActual = cutoff === null ? group.actual : group.actual.filter((point) => point.time <= cutoff);
        const visibleIssuances = cutoff === null
            ? issuancePaths
            : issuancePaths.filter((item) => item.created <= cutoff);
        const predictionTraces = visibleIssuances.map((item, index, list) => {
            const isLatest = index === list.length - 1;
            const cls = isLatest ? 'forecast-trace forecast-trace-latest' : 'forecast-trace forecast-trace-prior';
            const line = item.path.map(xy).join(' ');
            const dots = item.path.slice(1).map((point) => (
                `<circle class="forecast-point" cx="${xAt(point.time)}" cy="${yAt(point.value)}" r="2.5"/>`
            )).join('');
            return `<polyline class="${cls}" points="${line}"/>${dots}`;
        }).join('');
        const lastActualTime = group.actual[group.actual.length - 1].time;
        const cursorTime = cutoff === null
            ? lastActualTime
            : Math.min(Math.max(cutoff, minTime), maxTime);
        const nowX = xAt(cursorTime);
        const actualLine = visibleActual.length
            ? `<polyline class="actual-trace" points="${visibleActual.map(xy).join(' ')}"/>`
            : '';
        return `<svg class="forecast-chart" viewBox="0 0 640 180" role="img" aria-label="Actual memory trajectory with prediction issuances"><rect class="chart-frame" x="${plot.left}" y="${plot.top}" width="${plot.right - plot.left}" height="${plot.bottom - plot.top}"/>${grid}${actualLine}${predictionTraces}<line class="forecast-now" x1="${nowX}" x2="${nowX}" y1="${plot.top}" y2="${plot.bottom}"/>${xLabels}${yLabels}<text class="chart-axis-label" x="${(plot.left + plot.right) / 2}" y="174" text-anchor="middle">Elapsed time (seconds)</text><text class="chart-axis-label" x="16" y="${(plot.top + plot.bottom) / 2}" text-anchor="middle" transform="rotate(-90 16 ${(plot.top + plot.bottom) / 2})">Memory (MB)</text></svg>`;
    }

    // Optional process_forecasts: {process_name, pid, metric, created_at_ms,
    // points: [{target_at_ms, value_mb}]}. Timestamps use the sample clock.
    function renderProcessTimelines(data) {
        const available = collectForecastGroups(data);
        if (!available.length) return '';
        const timeLabel = time => new Date(time).toISOString();
        const replayControls = `<div class="replay-controls forecast-replay-controls" id="forecast-replay-controls">
            <div class="buttons">
                <button class="btn" type="button" id="btn-forecast-replay-play">Play</button>
                <button class="btn secondary" type="button" id="btn-forecast-replay-pause">Pause</button>
                <button class="btn secondary" type="button" id="btn-forecast-replay-reset">Reset</button>
            </div>
            <div class="meta" id="forecast-replay-meta">Frame 0 / 0</div>
            <div class="timeline">
                <input type="range" id="forecast-replay-timeline" aria-label="Prediction replay timeline" min="0" max="0" value="0">
                <div class="meta" id="forecast-replay-time-label">Elapsed: 0s</div>
                <div class="meta">
                    Speed:
                    <select id="forecast-replay-speed" aria-label="Prediction replay speed">
                        <option value="5">5x</option>
                        <option value="10">10x</option>
                        <option value="15" selected>15x</option>
                        <option value="20">20x</option>
                        <option value="25">25x</option>
                        <option value="30">30x</option>
                        <option value="40">40x</option>
                        <option value="50">50x</option>
                    </select>
                </div>
            </div>
        </div>`;
        const charts = available.map((group, index) => {
            const rows = group.predictions.slice().reverse().flatMap((prediction) => prediction.points.map((point) => {
                const actual = actualNear(group.actual, point.time, ACTUAL_MATCH_WINDOW_MS);
                return `<tr><td>${timeLabel(prediction.created)}</td><td>${timeLabel(point.time)}</td><td>${formatValue(point.value, 'MB')}</td><td>${actual ? formatValue(actual.value, 'MB') : 'Pending'}</td></tr>`;
            })).join('');
            return `<article class="process-forecast" data-forecast-group-index="${index}">
                <h3>${escapeHtml(group.name)} · PID ${escapeHtml(group.pid)} · ${group.metric === 'heap' ? 'Heap' : 'RSS'}</h3>
                <div class="forecast-chart-host" data-forecast-chart-host>${renderForecastChartSvg(group, null)}</div>
                <details class="forecast-values">
                    <summary>Issuance values</summary>
                    <div class="forecast-table-scroll" tabindex="0" role="region" aria-label="Forecast values for ${escapeHtml(group.name)} PID ${escapeHtml(group.pid)} ${group.metric}">
                        <table><thead><tr><th>Created (UTC)</th><th>Target (UTC)</th><th>Predicted</th><th>Actual at target</th></tr></thead><tbody>${rows}</tbody></table>
                    </div>
                </details>
            </article>`;
        }).join('');
        return `<section class="prediction-panel process-forecasts">
            <div class="prediction-panel-head">
                <div>
                    <span class="bpw-panel-badge">Process forecasts</span>
                    <h2>Process memory forecasts</h2>
                </div>
                <span class="prediction-panel-meta">${available.length} series</span>
            </div>
            ${replayControls}
            <ul class="forecast-chart-legend" aria-label="Chart legend">
                <li><span class="legend-swatch legend-actual"></span>Actual</li>
                <li><span class="legend-swatch legend-prediction"></span>Prediction issuance</li>
                <li><span class="legend-swatch legend-now"></span>Replay cursor</li>
            </ul>
            <div class="process-forecasts-grid">${charts}</div>
            <script type="application/json" id="bpw-forecast-replay-data">${JSON.stringify(available).replace(/</g, '\\u003c')}</script>
        </section>`;
    }

    function bindProcessForecastReplay(root) {
        if (!root) return () => {};
        const controls = root.querySelector('#forecast-replay-controls');
        const dataNode = root.querySelector('#bpw-forecast-replay-data');
        if (!controls || !dataNode) return () => {};
        let groups = [];
        try {
            groups = JSON.parse(dataNode.textContent || '[]');
        } catch (error) {
            return () => {};
        }
        if (!Array.isArray(groups) || !groups.length) return () => {};

        const timestamps = [...new Set(groups.flatMap((group) => (group.actual || []).map((point) => point.time)))]
            .filter((time) => Number.isFinite(time))
            .sort((a, b) => a - b);
        if (!timestamps.length) return () => {};

        const timeline = controls.querySelector('#forecast-replay-timeline');
        const meta = controls.querySelector('#forecast-replay-meta');
        const timeLabel = controls.querySelector('#forecast-replay-time-label');
        const playBtn = controls.querySelector('#btn-forecast-replay-play');
        const pauseBtn = controls.querySelector('#btn-forecast-replay-pause');
        const resetBtn = controls.querySelector('#btn-forecast-replay-reset');
        const speedSelect = controls.querySelector('#forecast-replay-speed');
        const hosts = [...root.querySelectorAll('[data-forecast-chart-host]')];
        if (!timeline || !meta || !timeLabel || !playBtn || !pauseBtn || !resetBtn || !speedSelect || !hosts.length) {
            return () => {};
        }

        let isPlaying = false;
        let playTimer = null;
        let currentFrame = timestamps.length - 1;
        let speedMultiplier = Number(speedSelect.value) || 15;
        timeline.min = '0';
        timeline.max = String(Math.max(0, timestamps.length - 1));

        function elapsedFor(timestamp) {
            const first = timestamps[0];
            return Math.max(0, Math.round((timestamp - first) / 1000));
        }

        function renderFrame(frameIndex) {
            currentFrame = Math.max(0, Math.min(frameIndex, timestamps.length - 1));
            const timestamp = timestamps[currentFrame];
            timeline.value = String(currentFrame);
            meta.textContent = `Frame ${currentFrame + 1} / ${timestamps.length}`;
            timeLabel.textContent = `Elapsed: ${elapsedFor(timestamp)}s | ${new Date(timestamp).toLocaleTimeString()}`;
            hosts.forEach((host, index) => {
                const group = groups[index];
                if (!group) return;
                host.innerHTML = renderForecastChartSvg(group, timestamp);
            });
        }

        function pause() {
            isPlaying = false;
            if (playTimer) {
                clearTimeout(playTimer);
                playTimer = null;
            }
        }

        function scheduleNext() {
            if (!isPlaying) return;
            if (currentFrame >= timestamps.length - 1) {
                isPlaying = false;
                return;
            }
            const nextDelay = Math.max(
                16,
                (timestamps[currentFrame + 1] - timestamps[currentFrame]) / speedMultiplier,
            );
            playTimer = setTimeout(() => {
                renderFrame(currentFrame + 1);
                scheduleNext();
            }, nextDelay);
        }

        function play() {
            if (isPlaying) return;
            if (currentFrame >= timestamps.length - 1) renderFrame(0);
            isPlaying = true;
            scheduleNext();
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
            if (!Number.isNaN(parsed) && parsed > 0) speedMultiplier = parsed;
        });

        renderFrame(timestamps.length - 1);
        return pause;
    }

    function render(data, selectedWindow) {
        const processTimelines = renderProcessTimelines(data);
        const checkpoints = normalizeCheckpoints(data?.prediction_checkpoints);
        const selected = selectCheckpoint(checkpoints, selectedWindow);
        const latest = latestReady(checkpoints);
        const selectedObserved = observedAtCheckpoint(data?.samples, selected);
        const ready = checkpoints.filter(checkpoint => statusOf(checkpoint) === 'ready');
        const peakRows = evolution(ready, 'predicted_peak_rss_mb', 'MB');
        const durationRows = evolution(ready, 'predicted_duration_s', 's');
        const timeline = checkpoints.length ? `<div class="prediction-timeline" role="list" aria-label="Prediction evaluation timeline">${checkpoints.map((checkpoint) => {
            const status = statusOf(checkpoint);
            const risk = riskOf(checkpoint);
            const isSelected = selected?.observation_window_s === checkpoint.observation_window_s;
            return `<button type="button" role="listitem" class="prediction-event status-${status}${isSelected ? ' is-selected' : ''}" aria-pressed="${isSelected ? 'true' : 'false'}" data-prediction-window="${checkpoint.observation_window_s}" aria-label="Prediction checkpoint at ${escapeHtml(formatElapsed(checkpoint.observation_window_s))}, status ${escapeHtml(status)}${status === 'ready' ? `, risk ${escapeHtml(risk)}` : ''}"><span class="prediction-event-time">${escapeHtml(formatElapsed(checkpoint.observation_window_s))}</span><span class="prediction-event-status">${escapeHtml(status)}</span><span class="prediction-event-risk">${status === 'ready' ? escapeHtml(risk) : 'Unavailable'}</span></button>`;
        }).join('')}</div>` : '';

        if (!checkpoints.length) {
            if (processTimelines) {
                return { selectedWindow: null, html: processTimelines };
            }
            const enabled = data?.predictionEnabled === true;
            return { selectedWindow: null, html: `<section class="prediction-empty" aria-label="Prediction checkpoints"><span class="bpw-panel-badge">Predictions</span><h2>${enabled ? 'Waiting for first checkpoint' : 'No prediction checkpoints'}</h2><p>${enabled ? 'Predictions will appear here as observation windows complete.' : 'This legacy run does not contain prediction checkpoints.'}</p></section>` };
        }

        const summaryCheckpoint = latest;
        const summary = summaryCheckpoint ? `<section class="prediction-summary prediction-panel"><div><span class="bpw-panel-badge">Latest prediction</span><h2>Latest prediction</h2><p>At ${escapeHtml(formatElapsed(summaryCheckpoint.observation_window_s))} into build</p></div><div class="prediction-summary-metrics"><div><span>Risk</span><strong class="risk-${escapeHtml(riskOf(summaryCheckpoint))}">${escapeHtml(riskOf(summaryCheckpoint))}</strong></div><div><span>Confidence</span><strong>${escapeHtml(summaryCheckpoint.confidence || 'Not available')}</strong></div><div><span>Peak RSS</span><strong>${formatValue(summaryCheckpoint.predicted_peak_rss_mb, 'MB')}</strong></div><div><span>Duration</span><strong>${formatValue(summaryCheckpoint.predicted_duration_s, 's')}</strong></div></div><small>${ready.length} of ${checkpoints.length} checkpoints ready. Predictions are advisory, not guaranteed outcomes.</small></section>` : `<section class="prediction-summary prediction-panel"><h2>No prediction available yet</h2><p>The stored checkpoints have not produced a ready prediction.</p></section>`;

        const selectedStatus = statusOf(selected);
        const selectedSignals = Array.isArray(selected?.signals) ? selected.signals : [];
        const details = selected ? `<section class="prediction-details-panel prediction-panel"><div class="prediction-panel-head"><div><span class="bpw-panel-badge">Checkpoint details</span><h2>At ${escapeHtml(formatElapsed(selected.observation_window_s))}</h2></div><span class="prediction-status">${escapeHtml(selectedStatus)}</span></div><div class="prediction-detail-grid"><div><span>Status</span><strong>${escapeHtml(selectedStatus)}</strong></div><div><span>Risk</span><strong>${selectedStatus === 'ready' ? escapeHtml(riskOf(selected)) : 'Unavailable'}</strong></div><div><span>Risk score</span><strong>${formatValue(selected.risk_score, '')}</strong></div><div><span>Confidence</span><strong>${escapeHtml(selected.confidence || 'Not available')}</strong></div><div><span>Predicted peak RSS</span><strong>${formatValue(selected.predicted_peak_rss_mb, 'MB')}</strong></div><div><span>Predicted duration</span><strong>${formatValue(selected.predicted_duration_s, 's')}</strong></div></div>${selectedSignals.length ? `<div class="prediction-signals"><strong>Signals</strong>${selectedSignals.slice(0, 4).map(signal => `<span>${escapeHtml(signal)}</span>`).join('')}${selectedSignals.length > 4 ? `<details><summary>More signals</summary>${selectedSignals.slice(4).map(signal => `<span>${escapeHtml(signal)}</span>`).join('')}</details>` : ''}</div>` : ''}${selected.message && (selectedStatus === 'error' || selectedStatus === 'skipped') ? `<p class="prediction-message">${escapeHtml(selected.message)}</p>` : ''}${selectedObserved ? `<div class="prediction-observed"><strong>Observed at checkpoint</strong><span>Aggregate RSS at ${escapeHtml(formatElapsed((selectedObserved.timestamp - Math.min(...data.samples.map(sample => Number(sample.Timestamp)))) / 1000))}: ${formatValue(selectedObserved.rss, 'MB')}</span></div>` : '<div class="prediction-observed"><strong>Observed at checkpoint</strong><span>Not available</span></div>'}<div class="prediction-detail-actions"><button type="button" class="btn secondary" data-prediction-chart-window="${selected.observation_window_s}">View on memory chart</button>${selected.provider_id || selected.model_version ? `<details><summary>Details</summary><span>${selected.provider_id ? `Provider: ${escapeHtml(selected.provider_id)}` : ''}${selected.model_version ? ` Model: ${escapeHtml(selected.model_version)}` : ''}</span></details>` : ''}</div></section>` : '';
        const riskRows = ready.length ? `<div class="prediction-evolution-row"><div><strong>Risk progression</strong><span>Discrete evaluation labels</span></div><div class="prediction-evolution-values">${ready.map(checkpoint => `<button type="button" class="prediction-evolution-value" data-prediction-window="${checkpoint.observation_window_s}"><span>${escapeHtml(formatElapsed(checkpoint.observation_window_s))}</span><strong>${escapeHtml(riskOf(checkpoint))}</strong></button>`).join('')}</div></div>` : '';
        const elapsedValues = (data?.samples || []).map(sample => finiteNumber(sample?.ElapsedTime)).filter(value => value !== null);
        const observedPeakRss = peakAggregateRss(data?.samples);
        const outcome = data?.finished === true ? `<section class="prediction-panel prediction-outcome"><div class="prediction-panel-head"><div><span class="bpw-panel-badge">Final observed outcome</span><h2>Completed run</h2></div></div><div class="prediction-detail-grid"><div><span>Observed duration</span><strong>${formatElapsed(elapsedValues.length ? Math.max(...elapsedValues) : null)}</strong></div><div><span>Observed peak RSS</span><strong>${formatValue(observedPeakRss, 'MB')}</strong></div></div><p>Observed values are shown separately; no accuracy or error claim is made without confirmed metric comparability.</p></section>` : '<section class="prediction-panel prediction-outcome"><h2>Final observed outcome</h2><p>Pending completion.</p></section>';

        return { selectedWindow: selected?.observation_window_s ?? null, html: `${processTimelines}${summary}<section class="prediction-panel"><div class="prediction-panel-head"><div><span class="bpw-panel-badge">Evolution</span><h2>Prediction evolution</h2></div><span class="prediction-panel-meta">${ready.length} of ${checkpoints.length} ready</span></div>${timeline}</section>${details}<section class="prediction-panel prediction-evolution"><div class="prediction-panel-head"><div><span class="bpw-panel-badge">Changes</span><h2>How estimates changed</h2></div></div>${renderMetricRow('Predicted peak RSS', peakRows, 'MB')}${renderMetricRow('Predicted duration', durationRows, 's')}${riskRows || '<p>Not enough ready checkpoints to show evolution.</p>'}</section>${outcome}` };
    }

    window.BpwPredictionView = {
        normalizeCheckpoints,
        formatElapsed,
        formatValue,
        buildMarkerData,
        render,
        observedAtCheckpoint,
        aggregateRssAtTimestamp,
        peakAggregateRss,
        actualNear,
        bindProcessForecastReplay,
    };
})();
