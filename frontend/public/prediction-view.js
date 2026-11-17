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
        // Reliability checkpoint markers are retired.
        return { shapes: [], annotations: [], traces: [] };
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
    const TIMELINE_MODES = new Set(['forecast', 'predict', 'bqml-boosted']);
    // TabFM (predict) is often 30–60s behind samples; warn sooner for TimesFM.
    const TIMELINE_LAG_WARN_S = {
        predict: 40,
        'bqml-boosted': 40,
        forecast: 30,
    };

    function isTimelinePredictionMode(mode) {
        return TIMELINE_MODES.has(String(mode || ''));
    }

    // Finished runs always open Replay. A sticky Live preference from the live
    // session must not keep Predictions locked on Live after /finish.
    function preferredForecastViewMode(data, explicitMode) {
        if (explicitMode === 'live' || explicitMode === 'replay') return explicitMode;
        if (data?.finished === true) return 'replay';
        if (typeof window !== 'undefined') {
            const sticky = window.__bpwForecastViewMode;
            if (sticky === 'live' || sticky === 'replay') return sticky;
        }
        return 'live';
    }

    function forecastFreshness(data) {
        const samples = Array.isArray(data?.samples) ? data.samples : [];
        const forecasts = Array.isArray(data?.process_forecasts) ? data.process_forecasts : [];
        let latestSampleMs = null;
        samples.forEach((sample) => {
            const timestamp = finiteNumber(sample?.Timestamp);
            if (timestamp === null) return;
            if (latestSampleMs === null || timestamp > latestSampleMs) latestSampleMs = timestamp;
        });
        let latestForecastMs = null;
        const methods = {};
        forecasts.forEach((forecast) => {
            const created = finiteNumber(forecast?.created_at_ms);
            if (created === null) return;
            if (latestForecastMs === null || created > latestForecastMs) latestForecastMs = created;
            const method = String(forecast?.method || 'unknown');
            methods[method] = (methods[method] || 0) + 1;
        });
        const lagS = latestSampleMs !== null && latestForecastMs !== null
            ? Math.max(0, Math.round((latestSampleMs - latestForecastMs) / 1000))
            : null;
        return {
            latestSampleMs,
            latestForecastMs,
            lagS,
            methods,
            forecastCount: forecasts.length,
        };
    }

    function formatForecastStatus(data, viewMode) {
        const mode = String(data?.prediction_mode || '');
        const freshness = forecastFreshness(data);
        const parts = [viewMode === 'live' ? 'Live' : 'Replay'];
        if (isTimelinePredictionMode(mode)) parts.push(mode);
        if (!freshness.forecastCount) {
            parts.push(isTimelinePredictionMode(mode) ? 'waiting for first forecast' : 'no forecasts');
            return parts.join(' · ');
        }
        const methodEntries = Object.entries(freshness.methods);
        if (methodEntries.length === 1) parts.push(methodEntries[0][0]);
        else if (methodEntries.length > 1) {
            parts.push(methodEntries.map(([name, count]) => `${name}×${count}`).join(' '));
        }
        const warnS = TIMELINE_LAG_WARN_S[mode] || 40;
        if (freshness.lagS === null) {
            parts.push('forecast clock unavailable');
        } else if (freshness.lagS >= warnS) {
            parts.push(`forecast ${freshness.lagS}s behind samples`);
        } else if (viewMode === 'live') {
            parts.push('tracking latest sample');
        } else {
            parts.push(`lag ${freshness.lagS}s`);
        }
        return parts.join(' · ');
    }

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

    function interpolatePath(path, time) {
        if (!path.length) return null;
        if (time <= path[0].time) return path[0].value;
        for (let i = 0; i < path.length - 1; i += 1) {
            const left = path[i];
            const right = path[i + 1];
            if (time > right.time) continue;
            if (right.time === left.time) return right.value;
            const ratio = (time - left.time) / (right.time - left.time);
            return left.value + (right.value - left.value) * ratio;
        }
        return path[path.length - 1].value;
    }

    const TRACK_GAP_BREAK_MS = 15000;

    // Stitch issuances into prediction tracks sampled only on actual times, plus a
    // short forward tip after the last sample. Large sample gaps stay empty.
    function buildTrackingSeries(predictions, actuals) {
        if (!predictions.length || !actuals.length) return { observed: [], forward: [] };
        const paths = predictions.map((prediction) => ({
            created: prediction.created,
            path: predictionPath(prediction, actuals),
            end: Math.max(...prediction.points.map((point) => point.time), prediction.created),
        }));
        const latest = paths[paths.length - 1];
        const lastActual = actuals[actuals.length - 1].time;
        const pointAt = (time) => {
            const active = paths.filter((item) => item.created <= time && time <= item.end);
            if (!active.length) return null;
            const values = active.map((item) => interpolatePath(item.path, time)).filter((value) => value !== null);
            if (!values.length) return null;
            const current = paths.slice().reverse().find((item) => item.created <= time);
            const mid = current ? interpolatePath(current.path, time) : values[values.length - 1];
            if (mid === null) return null;
            return {
                time,
                mid,
                min: Math.min(...values),
                max: Math.max(...values),
            };
        };
        const observed = actuals
            .map((point) => point.time)
            .filter((time) => time >= paths[0].created)
            .map(pointAt)
            .filter(Boolean);
        const forward = latest.path
            .filter((point) => point.time > lastActual)
            .map((point) => pointAt(point.time))
            .filter(Boolean);
        return { observed, forward };
    }

    function splitByGaps(points, maxGapMs) {
        if (!points.length) return [];
        const segments = [[points[0]]];
        for (let i = 1; i < points.length; i += 1) {
            const prev = points[i - 1];
            const next = points[i];
            if (next.time - prev.time > maxGapMs) segments.push([next]);
            else segments[segments.length - 1].push(next);
        }
        return segments.filter((segment) => segment.length > 0);
    }

    function areaPath(points, xAt, yAt, lowerKey, upperKey) {
        if (points.length < 2) return '';
        const upper = points.map((point) => `${xAt(point.time)},${yAt(point[upperKey])}`).join(' ');
        const lower = points.slice().reverse().map((point) => `${xAt(point.time)},${yAt(point[lowerKey])}`).join(' ');
        return `M ${upper} L ${lower} Z`;
    }

    function polylinePath(points, xAt, yAt, valueKey) {
        if (points.length < 2) return '';
        return points.map((point) => `${xAt(point.time)},${yAt(point[valueKey])}`).join(' ');
    }

    function collectForecastGroups(data, options = {}) {
        const allowEmptyPredictions = options.allowEmptyPredictions === true;
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
        return [...groups.values()]
            .filter((group) => group.actual.length && (allowEmptyPredictions || group.predictions.length))
            .map((group) => {
                group.actual.sort((a, b) => a.time - b.time);
                group.predictions.sort((a, b) => a.created - b.created);
                return group;
            });
    }

    function renderForecastChartSvg(group, untilMs) {
        if (!group?.actual?.length) return '';
        const fullTrack = buildTrackingSeries(group.predictions || [], group.actual);
        const trackPoints = fullTrack.observed.concat(fullTrack.forward);
        const allValues = group.actual.map((point) => point.value)
            .concat(trackPoints.flatMap((point) => [point.min, point.max, point.mid]));
        const minTime = group.actual[0].time;
        const maxTime = Math.max(
            group.actual[group.actual.length - 1].time,
            trackPoints[trackPoints.length - 1]?.time ?? group.actual[group.actual.length - 1].time,
        );
        const minValue = Math.min(...allValues);
        const maxValue = Math.max(...allValues, 1);
        const valuePad = Math.max((maxValue - minValue) * 0.08, maxValue * 0.04, 1);
        const yMin = Math.max(0, minValue - valuePad);
        const yMax = maxValue + valuePad;
        const plot = { left: 64, right: 900, top: 24, bottom: 236 };
        const xAt = time => plot.left + (plot.right - plot.left) * (time - minTime) / (maxTime - minTime || 1);
        const yAt = value => plot.bottom - (plot.bottom - plot.top) * (value - yMin) / (yMax - yMin || 1);
        const xy = point => `${xAt(point.time)},${yAt(point.value)}`;
        const elapsedS = time => (time - minTime) / 1000;
        const xTicks = niceTicks(minTime, maxTime, 6);
        const yTicks = niceTicks(yMin, yMax, 6);
        const grid = yTicks.map((value) => `<line class="chart-grid" x1="${plot.left}" x2="${plot.right}" y1="${yAt(value)}" y2="${yAt(value)}"/>`).join('')
            + xTicks.map((time) => `<line class="chart-grid" x1="${xAt(time)}" x2="${xAt(time)}" y1="${plot.top}" y2="${plot.bottom}"/>`).join('');
        const xLabels = xTicks.map((time) => `<text class="chart-tick" x="${xAt(time)}" y="${plot.bottom + 20}" text-anchor="middle">${Math.round(elapsedS(time))}s</text>`).join('');
        const yLabels = yTicks.map((value) => `<text class="chart-tick" x="${plot.left - 10}" y="${yAt(value) + 4}" text-anchor="end">${Math.round(value)}</text>`).join('');

        const cutoff = finiteNumber(untilMs);
        const visibleActual = cutoff === null ? group.actual : group.actual.filter((point) => point.time <= cutoff);
        const visibleObserved = cutoff === null ? fullTrack.observed : fullTrack.observed.filter((point) => point.time <= cutoff);
        const lastActualTime = group.actual[group.actual.length - 1].time;
        const showForward = cutoff === null || cutoff >= lastActualTime;
        const visibleForward = !showForward
            ? []
            : (cutoff === null ? fullTrack.forward : fullTrack.forward.filter((point) => point.time <= cutoff));
        const observedSegments = splitByGaps(visibleObserved, TRACK_GAP_BREAK_MS);
        const band = observedSegments.map((segment) => areaPath(segment, xAt, yAt, 'min', 'max'))
            .filter(Boolean)
            .map((path) => `<path class="forecast-band" d="${path}"/>`)
            .join('');
        const predictionLine = observedSegments.map((segment) => {
            const points = polylinePath(segment, xAt, yAt, 'mid');
            return points ? `<polyline class="forecast-trace forecast-trace-latest" points="${points}"/>` : '';
        }).join('');
        const forwardPoints = visibleObserved.length && visibleForward.length
            ? [visibleObserved[visibleObserved.length - 1]].concat(visibleForward)
            : visibleForward;
        const forwardLine = polylinePath(forwardPoints, xAt, yAt, 'mid');
        const forwardTrace = forwardLine
            ? `<polyline class="forecast-trace forecast-trace-forward" points="${forwardLine}"/>`
            : '';
        const cursorTime = cutoff === null
            ? lastActualTime
            : Math.min(Math.max(cutoff, minTime), maxTime);
        const nowX = xAt(cursorTime);
        const actualLine = visibleActual.length
            ? `<polyline class="actual-trace" points="${visibleActual.map(xy).join(' ')}"/>`
            : '';
        // One marker per issuance at created_at so live runs show when each
        // forecast arrived (the stitched prediction line alone hides that).
        const issuanceMarkers = (group.predictions || []).map((prediction) => {
            if (cutoff !== null && prediction.created > cutoff) return '';
            if (prediction.created < minTime || prediction.created > maxTime) return '';
            const origin = actualNear(group.actual, prediction.created, ACTUAL_MATCH_WINDOW_MS);
            const value = origin?.value ?? prediction.points?.[0]?.value;
            if (!Number.isFinite(value)) return '';
            const title = `Issuance at ${Math.round(elapsedS(prediction.created))}s`;
            return `<circle class="forecast-point forecast-issuance" cx="${xAt(prediction.created)}" cy="${yAt(value)}" r="5"><title>${escapeHtml(title)}</title></circle>`;
        }).join('');
        const midY = (plot.top + plot.bottom) / 2;
        return `<svg class="forecast-chart" viewBox="0 0 960 280" role="img" aria-label="Actual memory trajectory with prediction track"><rect class="chart-frame" x="${plot.left}" y="${plot.top}" width="${plot.right - plot.left}" height="${plot.bottom - plot.top}"/>${grid}${band}${actualLine}${predictionLine}${forwardTrace}${issuanceMarkers}<line class="forecast-now" x1="${nowX}" x2="${nowX}" y1="${plot.top}" y2="${plot.bottom}"/>${xLabels}${yLabels}<text class="chart-axis-label" x="${(plot.left + plot.right) / 2}" y="268" text-anchor="middle">Elapsed time (seconds)</text><text class="chart-axis-label" x="18" y="${midY}" text-anchor="middle" transform="rotate(-90 18 ${midY})">Memory (MB)</text></svg>`;
    }

    // Optional process_forecasts: {process_name, pid, metric, created_at_ms,
    // points: [{target_at_ms, value_mb}]}. Timestamps use the sample clock.
    function renderForecastTablesHtml(groups) {
        const timeLabel = (time) => new Date(time).toISOString();
        return groups.map((group) => {
            const rows = group.predictions.slice().reverse().flatMap((prediction) => prediction.points.map((point) => {
                const actual = actualNear(group.actual, point.time, ACTUAL_MATCH_WINDOW_MS);
                return `<tr><td>${timeLabel(prediction.created)}</td><td>${timeLabel(point.time)}</td><td>${formatValue(point.value, 'MB')}</td><td>${actual ? formatValue(actual.value, 'MB') : 'Pending'}</td></tr>`;
            })).join('');
            const body = rows || '<tr><td colspan="4">Waiting for forecast issuances</td></tr>';
            return `<article class="process-forecast process-forecast-table"><h3>${escapeHtml(group.name)} · PID ${escapeHtml(group.pid)} · ${group.metric === 'heap' ? 'Heap' : 'RSS'}</h3><div class="forecast-table-scroll" tabindex="0" role="region" aria-label="Forecast values for ${escapeHtml(group.name)} PID ${escapeHtml(group.pid)} ${group.metric}"><table><thead><tr><th>Created (UTC)</th><th>Target (UTC)</th><th>Predicted</th><th>Actual at target</th></tr></thead><tbody>${body}</tbody></table></div></article>`;
        }).join('');
    }

    function renderForecastChartsHtml(groups) {
        return groups.map((group, index) => (
            `<article class="process-forecast process-forecast-chart" data-forecast-group-index="${index}"><h3>${escapeHtml(group.name)} · PID ${escapeHtml(group.pid)} · ${group.metric === 'heap' ? 'Heap' : 'RSS'}</h3><div class="forecast-chart-host" data-forecast-chart-host>${renderForecastChartSvg(group, null)}</div></article>`
        )).join('');
    }

    function renderProcessTimelines(data) {
        const timelineMode = isTimelinePredictionMode(data?.prediction_mode);
        const available = collectForecastGroups(data, { allowEmptyPredictions: timelineMode });
        if (!available.length) {
            if (!timelineMode) return '';
            const emptyMode = preferredForecastViewMode(data);
            return `<section class="prediction-panel process-forecasts" data-forecast-panel data-prediction-mode="${escapeHtml(String(data.prediction_mode || ''))}"><h2>Process memory forecasts</h2><p id="forecast-live-status" class="forecast-live-status">${escapeHtml(formatForecastStatus(data, emptyMode))}</p><p>No eligible Gradle/Kotlin process samples yet.</p></section>`;
        }
        const defaultMode = preferredForecastViewMode(data);
        if (typeof window !== 'undefined' && data?.finished === true) {
            window.__bpwForecastViewMode = 'replay';
        }
        const lagWarn = TIMELINE_LAG_WARN_S[String(data?.prediction_mode || '')] || 40;
        const freshness = forecastFreshness(data);
        const delayed = freshness.forecastCount > 0 && freshness.lagS !== null && freshness.lagS >= lagWarn;
        const waiting = freshness.forecastCount === 0;
        const replayControls = `<div class="replay-controls forecast-replay-controls" id="forecast-replay-controls" data-forecast-view-mode="${defaultMode}">
            <div class="forecast-view-mode" role="group" aria-label="Forecast view mode">
                <button class="btn${defaultMode === 'live' ? '' : ' secondary'}" type="button" id="btn-forecast-view-live" data-forecast-view-mode="live" aria-pressed="${defaultMode === 'live' ? 'true' : 'false'}">Live</button>
                <button class="btn${defaultMode === 'replay' ? '' : ' secondary'}" type="button" id="btn-forecast-view-replay" data-forecast-view-mode="replay" aria-pressed="${defaultMode === 'replay' ? 'true' : 'false'}">Replay</button>
            </div>
            <div class="buttons forecast-replay-buttons">
                <button class="btn" type="button" id="btn-forecast-replay-play">Play</button>
                <button class="btn secondary" type="button" id="btn-forecast-replay-pause">Pause</button>
                <button class="btn secondary" type="button" id="btn-forecast-replay-reset">Reset</button>
            </div>
            <div class="meta" id="forecast-replay-meta">Frame 0 / 0</div>
            <div class="timeline forecast-replay-timeline-wrap">
                <input type="range" id="forecast-replay-timeline" aria-label="Prediction replay timeline" min="0" max="0" value="0">
                <div class="meta" id="forecast-replay-time-label">Elapsed: 0s</div>
                <div class="meta">
                    Speed:
                    <select id="forecast-replay-speed" aria-label="Prediction replay speed">
                        <option value="5">5x</option>
                        <option value="10">10x</option>
                        <option value="15" selected>15x</option>
                        <option value="20">20x</option>
                        <option value="30">30x</option>
                        <option value="50">50x</option>
                    </select>
                </div>
            </div>
        </div>`;
        const sharedLegend = `<ul class="forecast-chart-legend" aria-label="Chart legend"><li><span class="legend-swatch legend-actual"></span>Actual</li><li><span class="legend-swatch legend-prediction"></span>Prediction</li><li><span class="legend-swatch legend-issuance"></span>Issuance</li><li><span class="legend-swatch legend-band"></span>Prediction range</li><li><span class="legend-swatch legend-now"></span>Latest sample</li></ul>`;
        const statusClass = `forecast-live-status${delayed ? ' is-delayed' : ''}${waiting ? ' is-waiting' : ''}`;
        return `<section class="prediction-panel process-forecasts" data-forecast-panel data-prediction-mode="${escapeHtml(String(data?.prediction_mode || ''))}"><h2>Process memory forecasts</h2><p id="forecast-live-status" class="${statusClass}">${escapeHtml(formatForecastStatus(data, defaultMode))}</p><p class="forecast-panel-help">Live follows the latest sample and keeps the last forecast while new ones catch up. Each orange point marks when a forecast was issued. Replay scrubs actual and prediction tracks together.</p>${replayControls}${sharedLegend}<div class="process-forecast-charts" aria-label="Forecast charts">${renderForecastChartsHtml(available)}</div><script type="application/json" id="bpw-forecast-replay-data">${JSON.stringify(available).replace(/</g, '\\u003c')}</script></section>`;
    }

    function bindProcessForecastView(root, options = {}) {
        if (!root) return { stop() {}, update() { return false; }, getMode() { return 'live'; } };
        const controls = root.querySelector('#forecast-replay-controls');
        const dataNode = root.querySelector('#bpw-forecast-replay-data');
        const statusNode = root.querySelector('#forecast-live-status');
        const chartsNode = root.querySelector('.process-forecast-charts');
        const liveBtn = root.querySelector('#btn-forecast-view-live');
        const replayBtn = root.querySelector('#btn-forecast-view-replay');
        if (!controls || !dataNode) return { stop() {}, update() { return false; }, getMode() { return 'live'; } };

        let groups = [];
        try {
            groups = JSON.parse(dataNode.textContent || '[]');
        } catch (error) {
            groups = [];
        }
        if (!Array.isArray(groups)) groups = [];

        let timestamps = [];
        let hosts = [];
        const timeline = controls.querySelector('#forecast-replay-timeline');
        const meta = controls.querySelector('#forecast-replay-meta');
        const timeLabel = controls.querySelector('#forecast-replay-time-label');
        const playBtn = controls.querySelector('#btn-forecast-replay-play');
        const pauseBtn = controls.querySelector('#btn-forecast-replay-pause');
        const resetBtn = controls.querySelector('#btn-forecast-replay-reset');
        const speedSelect = controls.querySelector('#forecast-replay-speed');

        let isPlaying = false;
        let currentFrame = 0;
        let speedMultiplier = Number(speedSelect?.value) || 15;
        let clock = null;
        let latestData = options.data || (
            options.finished === true ? { finished: true } : { finished: false }
        );
        let mode = preferredForecastViewMode(latestData, options.initialMode);
        const clockApi = (typeof globalThis !== 'undefined' && globalThis.BpwPlaybackClock)
            || (typeof window !== 'undefined' && window.BpwPlaybackClock)
            || null;

        function destroyClock() {
            if (!clock) return;
            clock.destroy();
            clock = null;
            isPlaying = false;
        }

        function cursorMsForFrame(frameIndex) {
            if (!timestamps.length) return 0;
            const idx = Math.max(0, Math.min(frameIndex, timestamps.length - 1));
            return timestamps[idx] - timestamps[0];
        }

        function ensureClock() {
            if (!clockApi || !timestamps.length) {
                destroyClock();
                return null;
            }
            const preserveFrame = currentFrame;
            const wasPlaying = isPlaying && mode === 'replay';
            destroyClock();
            clock = clockApi.createPlaybackClock({
                timestamps,
                speed: speedMultiplier,
                onPosition: (position) => {
                    const idx = position.sampleIndex;
                    if (idx < 0) return;
                    renderFrame(idx, { fromClock: true });
                },
                onStateChange: (state) => {
                    isPlaying = Boolean(state.playing);
                },
            });
            clock.seekTo(cursorMsForFrame(preserveFrame));
            if (wasPlaying) clock.play();
            return clock;
        }

        function rebuildTimestamps() {
            timestamps = [...new Set(groups.flatMap((group) => (group.actual || []).map((point) => point.time)))]
                .filter((time) => Number.isFinite(time))
                .sort((a, b) => a - b);
            hosts = [...root.querySelectorAll('[data-forecast-chart-host]')];
            if (timeline) {
                timeline.min = '0';
                timeline.max = String(Math.max(0, timestamps.length - 1));
            }
            if (clock || (mode === 'replay' && isPlaying)) {
                ensureClock();
            } else {
                destroyClock();
            }
        }

        function elapsedFor(timestamp) {
            if (!timestamps.length) return 0;
            return Math.max(0, Math.round((timestamp - timestamps[0]) / 1000));
        }

        function refreshStatus() {
            if (!statusNode || !latestData) return;
            const freshness = forecastFreshness(latestData);
            const warnS = TIMELINE_LAG_WARN_S[String(latestData?.prediction_mode || '')] || 40;
            statusNode.textContent = formatForecastStatus(latestData, mode);
            statusNode.classList.toggle('is-delayed', freshness.forecastCount > 0 && freshness.lagS !== null && freshness.lagS >= warnS);
            statusNode.classList.toggle('is-waiting', freshness.forecastCount === 0);
        }

        function applyModeChrome() {
            controls.dataset.forecastViewMode = mode;
            controls.classList.toggle('is-live', mode === 'live');
            controls.classList.toggle('is-replay', mode === 'replay');
            if (liveBtn) {
                liveBtn.setAttribute('aria-pressed', mode === 'live' ? 'true' : 'false');
                liveBtn.classList.toggle('secondary', mode !== 'live');
            }
            if (replayBtn) {
                replayBtn.setAttribute('aria-pressed', mode === 'replay' ? 'true' : 'false');
                replayBtn.classList.toggle('secondary', mode !== 'replay');
            }
            if (typeof window !== 'undefined') window.__bpwForecastViewMode = mode;
            refreshStatus();
        }

        function renderFrame(frameIndex, opts = {}) {
            if (!timestamps.length || !hosts.length) return;
            currentFrame = Math.max(0, Math.min(frameIndex, timestamps.length - 1));
            const timestamp = timestamps[currentFrame];
            if (timeline) timeline.value = String(currentFrame);
            if (meta) {
                meta.textContent = mode === 'live'
                    ? `Live · sample ${currentFrame + 1} / ${timestamps.length}`
                    : `Frame ${currentFrame + 1} / ${timestamps.length}`;
            }
            if (timeLabel) {
                timeLabel.textContent = `Elapsed: ${elapsedFor(timestamp)}s | ${new Date(timestamp).toLocaleTimeString()}`;
            }
            hosts.forEach((host, index) => {
                const group = groups[index];
                if (!group) return;
                host.innerHTML = renderForecastChartSvg(group, timestamp);
            });
            if (!opts.fromClock && clock) {
                clock.seekTo(cursorMsForFrame(currentFrame));
            }
        }

        function pause() {
            if (clock) clock.pause();
            isPlaying = false;
        }

        function play() {
            if (mode !== 'replay' || !timestamps.length) return;
            if (!clock) ensureClock();
            if (!clock) return;
            if (currentFrame >= timestamps.length - 1) {
                clock.seekTo(0);
            }
            clock.play();
        }

        function stop() {
            pause();
            destroyClock();
        }

        function setMode(nextMode) {
            const resolved = nextMode === 'replay' ? 'replay' : 'live';
            if (resolved === mode) {
                applyModeChrome();
                return;
            }
            mode = resolved;
            pause();
            applyModeChrome();
            // Live always snaps to the tip. Replay keeps the current frame so scrubbers
            // can set the target frame after switching without being overwritten.
            if (mode === 'live') {
                destroyClock();
                renderFrame(Math.max(0, timestamps.length - 1));
            }
        }

        function update(data) {
            if (!data) return false;
            const wasLiveUnfinished = mode === 'live' && latestData?.finished !== true;
            latestData = data;
            if (data.finished === true && wasLiveUnfinished) {
                // Run just finished while Predictions was following Live: flip to Replay once.
                setMode('replay');
            }
            const timelineMode = isTimelinePredictionMode(data.prediction_mode);
            const nextGroups = collectForecastGroups(data, { allowEmptyPredictions: timelineMode });
            if (!nextGroups.length) return false;
            groups = nextGroups;
            if (dataNode) dataNode.textContent = JSON.stringify(groups);
            if (chartsNode) chartsNode.innerHTML = renderForecastChartsHtml(groups);
            rebuildTimestamps();
            refreshStatus();
            if (!timestamps.length) return true;
            if (mode === 'live') {
                pause();
                destroyClock();
                renderFrame(timestamps.length - 1);
            } else {
                renderFrame(Math.min(currentFrame, timestamps.length - 1));
            }
            return true;
        }

        rebuildTimestamps();
        if (!timestamps.length || !timeline || !meta || !timeLabel || !playBtn || !pauseBtn || !resetBtn || !speedSelect) {
            applyModeChrome();
            return {
                stop,
                update,
                getMode() { return mode; },
                setMode,
            };
        }

        if (liveBtn) liveBtn.addEventListener('click', () => setMode('live'));
        if (replayBtn) replayBtn.addEventListener('click', () => setMode('replay'));
        playBtn.addEventListener('click', play);
        pauseBtn.addEventListener('click', pause);
        resetBtn.addEventListener('click', () => {
            pause();
            setMode('replay');
            if (!clock) ensureClock();
            if (clock) clock.reset();
            else renderFrame(0);
        });
        timeline.addEventListener('input', () => {
            const frame = Number(timeline.value);
            pause();
            setMode('replay');
            if (!clock) ensureClock();
            renderFrame(frame);
        });
        speedSelect.addEventListener('change', () => {
            const parsed = Number(speedSelect.value);
            if (Number.isNaN(parsed) || parsed <= 0) return;
            speedMultiplier = parsed;
            if (clock) clock.setSpeed(parsed);
        });

        applyModeChrome();
        renderFrame(mode === 'live' ? timestamps.length - 1 : timestamps.length - 1);
        return {
            stop,
            update,
            getMode() { return mode; },
            setMode,
        };
    }

    function bindProcessForecastReplay(root, options = {}) {
        const controller = bindProcessForecastView(root, options);
        return () => controller.stop();
    }

    function render(data, selectedWindow) {
        // Reliability checkpoint panels are retired; timeline modes use process forecasts only.
        return { selectedWindow: null, html: renderProcessTimelines(data) };
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
        isTimelinePredictionMode,
        preferredForecastViewMode,
        forecastFreshness,
        formatForecastStatus,
        bindProcessForecastView,
        bindProcessForecastReplay,
    };
})();
