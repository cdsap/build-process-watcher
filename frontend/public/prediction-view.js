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
    const TIMELINE_MODES = new Set(['forecast', 'predict', 'bqml-boosted', 'tabpfn']);
    // TabFM (predict) is often 30–60s behind samples; warn sooner for TimesFM.
    const TIMELINE_LAG_WARN_S = {
        predict: 40,
        'bqml-boosted': 40,
        tabpfn: 45,
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

    function percentileSorted(sorted, p) {
        if (!sorted.length) return null;
        if (sorted.length === 1) return sorted[0];
        const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
        return sorted[idx];
    }

    function forecastLatencySummary(data) {
        const forecasts = Array.isArray(data?.process_forecasts) ? data.process_forecasts : [];
        const pick = (key) => forecasts
            .map((forecast) => finiteNumber(forecast?.[key]))
            .filter((value) => value !== null && value >= 0)
            .sort((a, b) => a - b);
        const latency = pick('latency_ms');
        const provider = pick('provider_latency_ms');
        const inference = pick('inference_latency_ms');
        const fallbackCount = forecasts.filter((forecast) => (
            forecast?.fallback === true || String(forecast?.method || '') === 'last_value'
        )).length;
        let latest = null;
        let latestCreated = null;
        forecasts.forEach((forecast) => {
            const created = finiteNumber(forecast?.created_at_ms);
            const value = finiteNumber(forecast?.latency_ms);
            if (value === null || value < 0) return;
            if (latestCreated === null || (created !== null && created >= latestCreated) || (created === null && latest === null)) {
                latest = value;
                if (created !== null) latestCreated = created;
            }
        });
        return {
            count: forecasts.length,
            timedCount: latency.length,
            p50: percentileSorted(latency, 50),
            p95: percentileSorted(latency, 95),
            providerP50: percentileSorted(provider, 50),
            providerP95: percentileSorted(provider, 95),
            inferenceP50: percentileSorted(inference, 50),
            inferenceP95: percentileSorted(inference, 95),
            providerTimedCount: provider.length,
            inferenceTimedCount: inference.length,
            fallbackCount,
            fallbackPct: forecasts.length ? Math.round((fallbackCount / forecasts.length) * 100) : 0,
            latest,
        };
    }

    function formatLatencyMs(value) {
        if (value === null || value === undefined || !Number.isFinite(value)) return null;
        if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}s`;
        return `${Math.round(value)}ms`;
    }

    function formatLatencyCell(value) {
        return formatLatencyMs(value) || '—';
    }

    function formatForecastLatencySummary(summary) {
        if (!summary || !summary.timedCount) return '';
        const parts = [];
        const p50 = formatLatencyMs(summary.p50);
        const p95 = formatLatencyMs(summary.p95);
        if (p50) parts.push(`p50 ${p50}`);
        if (p95) parts.push(`p95 ${p95}`);
        const inference = formatLatencyMs(summary.inferenceP50);
        if (inference) parts.push(`inference ${inference}`);
        const provider = formatLatencyMs(summary.providerP50);
        if (provider) parts.push(`provider ${provider}`);
        parts.push(`fallback ${summary.fallbackPct}%`);
        return parts.join(' · ');
    }

    // Known timeline backends. Table names follow the private provider defaults
    // (PREDICTIVE_BQ_DATASET / context table / boosted train table).
    const TIMELINE_INFERENCE_CATALOG = {
        forecast: {
            engine: 'TimesFM AI.FORECAST',
            route: 'POST /forecast',
            inferenceSource: 'AI.FORECAST in-query series',
            inferenceTable: null,
            defaultModel: 'bq-ai-forecast-timesfm-v1',
        },
        predict: {
            engine: 'TabFM AI.PREDICT',
            route: 'POST /tabpredict',
            inferenceSource: 'BigQuery context table',
            inferenceTable: 'predictive_reliability.tabfm_context',
            defaultModel: 'bq-ai-predict-tabfm-v1',
        },
        'bqml-boosted': {
            engine: 'BQML boosted trees',
            route: 'POST /bqml-boosted',
            inferenceSource: 'BigQuery ML model + train table',
            inferenceTable: 'predictive_reliability.bqml_boosted_train',
            modelId: 'bpw_process_boosted_v1',
            defaultModel: 'bpw_process_boosted_v1',
        },
        tabpfn: {
            engine: 'TabPFN GPU',
            route: 'POST /tabpfn',
            inferenceSource: 'TabPFN VM (no BigQuery table)',
            inferenceTable: null,
            defaultModel: 'tabpfn-timeline-v1',
        },
    };

    function forecastModelSummary(data) {
        const mode = String(data?.prediction_mode || '');
        const catalog = TIMELINE_INFERENCE_CATALOG[mode] || null;
        const forecasts = Array.isArray(data?.process_forecasts) ? data.process_forecasts : [];
        const modelCounts = {};
        const methodCounts = {};
        forecasts.forEach((forecast) => {
            const model = String(forecast?.model_version || '').trim();
            if (model) modelCounts[model] = (modelCounts[model] || 0) + 1;
            const method = String(forecast?.method || '').trim();
            if (method) methodCounts[method] = (methodCounts[method] || 0) + 1;
        });
        const models = Object.entries(modelCounts)
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([name, count]) => ({ name, count }));
        const methods = Object.entries(methodCounts)
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([name, count]) => ({ name, count }));
        const primaryModel = models[0]?.name
            || catalog?.defaultModel
            || catalog?.modelId
            || null;
        return {
            mode,
            engine: catalog?.engine || null,
            route: catalog?.route || null,
            modelId: catalog?.modelId || null,
            inferenceSource: catalog?.inferenceSource || null,
            inferenceTable: catalog?.inferenceTable || null,
            primaryModel,
            models,
            methods,
            forecastCount: forecasts.length,
        };
    }

    function formatModelCountList(entries) {
        if (!entries?.length) return '';
        return entries.map((entry) => (
            entries.length === 1 && entry.count === 1
                ? entry.name
                : `${entry.name}×${entry.count}`
        )).join(' · ');
    }

    function renderForecastModelHtml(data) {
        if (!isTimelinePredictionMode(data?.prediction_mode)) return '';
        const summary = forecastModelSummary(data);
        if (!summary.mode) return '';
        const rows = [];
        rows.push(['Mode', summary.mode]);
        if (summary.engine) rows.push(['Engine', summary.engine]);
        if (summary.route) rows.push(['Provider', summary.route]);
        if (summary.modelId) rows.push(['Model id', summary.modelId]);
        const modelList = formatModelCountList(summary.models);
        if (modelList) rows.push(['Model version', modelList]);
        else if (summary.primaryModel) rows.push(['Model version', summary.primaryModel]);
        const methodList = formatModelCountList(summary.methods);
        if (methodList) rows.push(['Method', methodList]);
        if (summary.inferenceTable) {
            rows.push(['Inference table', summary.inferenceTable]);
        } else if (summary.inferenceSource) {
            rows.push(['Inference', summary.inferenceSource]);
        }
        if (!rows.length) return '';
        const body = rows.map(([label, value]) => (
            `<tr><th scope="row">${escapeHtml(label)}</th><td><code>${escapeHtml(value)}</code></td></tr>`
        )).join('');
        return `<div class="forecast-model-table-wrap" data-forecast-model>`
            + `<table class="forecast-model-table" aria-label="Forecast model">`
            + `<caption>Forecast model</caption>`
            + `<tbody>${body}</tbody></table></div>`;
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
        const latency = forecastLatencySummary(data);
        const latestLatency = formatLatencyMs(latency.latest);
        if (latestLatency) parts.push(latestLatency);
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

    function renderForecastLatencyHtml(data) {
        const summary = forecastLatencySummary(data);
        if (!summary || !summary.timedCount) return '';
        const row = (label, p50, p95) => (
            `<tr><th scope="row">${escapeHtml(label)}</th>`
            + `<td>${escapeHtml(formatLatencyCell(p50))}</td>`
            + `<td>${escapeHtml(formatLatencyCell(p95))}</td></tr>`
        );
        return `<div class="forecast-latency-table-wrap" data-forecast-latency>`
            + `<table class="forecast-latency-table" aria-label="Forecast latency">`
            + `<caption>Forecast latency</caption>`
            + `<thead><tr><th scope="col">Metric</th><th scope="col">p50</th><th scope="col">p95</th></tr></thead>`
            + `<tbody>`
            + row('End-to-end', summary.p50, summary.p95)
            + row('Provider', summary.providerP50, summary.providerP95)
            + row('Inference', summary.inferenceP50, summary.inferenceP95)
            + `<tr><th scope="row">Fallback</th>`
            + `<td colspan="2">${escapeHtml(`${summary.fallbackPct}%`)}`
            + ` <span class="forecast-latency-fallback-count">(${summary.fallbackCount}/${summary.count})</span></td></tr>`
            + `</tbody></table></div>`;
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

    function actualAtOrBefore(actuals, atMs) {
        const cursor = finiteNumber(atMs);
        if (cursor === null || !Array.isArray(actuals) || !actuals.length) return null;
        let best = null;
        actuals.forEach((sample) => {
            const time = finiteNumber(sample?.time);
            const value = finiteNumber(sample?.value);
            if (time === null || value === null || value < 0 || time > cursor) return;
            if (!best || time > best.time) best = { time, value };
        });
        return best;
    }

    function predictionPath(prediction, actuals) {
        // Origin must be an observation available at issuance time (never after).
        const origin = actualAtOrBefore(actuals, prediction.created);
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

    // All timeline modes draw each issuance as its own short horizon polyline
    // (origin → +10/+30/+60) with original geometry preserved during replay.
    function usesIssuancePolylines(mode) {
        return TIMELINE_MODES.has(String(mode || ''));
    }

    function normalizeIssuanceHistoryMode(mode) {
        const value = String(mode || 'latest');
        if (value === 'all' || value === 'recent') return value;
        return 'latest';
    }

    function preferredIssuanceHistoryMode(explicitMode) {
        const normalized = normalizeIssuanceHistoryMode(explicitMode);
        if (explicitMode != null && String(explicitMode) !== '') return normalized;
        if (typeof window !== 'undefined') {
            const sticky = window.__bpwForecastHistoryMode;
            if (sticky === 'all' || sticky === 'recent' || sticky === 'latest') return sticky;
        }
        return 'latest';
    }

    // Reveal issuances as they arrive; keep each forecast's original issuance
    // origin and horizon values (never re-anchor to the replay cursor).
    // historyMode limits which forecast polylines are drawn (markers use all revealed).
    function visibleIssuancePaths(group, untilMs, historyMode = 'latest') {
        const cutoff = finiteNumber(untilMs);
        const available = (group.predictions || [])
            .filter((prediction) => cutoff === null || prediction.created <= cutoff);
        let selected;
        switch (normalizeIssuanceHistoryMode(historyMode)) {
            case 'all':
                selected = available;
                break;
            case 'recent':
                selected = available.slice(-3);
                break;
            default:
                selected = available.slice(-1);
                break;
        }
        return selected
            .map((prediction) => {
                const fullPath = predictionPath(prediction, group.actual);
                const horizonPoints = (prediction.points || []).map((point) => ({
                    time: point.time,
                    value: point.value,
                }));
                return {
                    created: prediction.created,
                    fullPath,
                    path: fullPath,
                    horizonPoints,
                };
            })
            .filter((item) => item.path.length >= 2);
    }

    function revealedIssuanceMarkers(group, untilMs) {
        const cutoff = finiteNumber(untilMs);
        return (group.predictions || [])
            .filter((prediction) => cutoff === null || prediction.created <= cutoff)
            .map((prediction) => {
                const fullPath = predictionPath(prediction, group.actual);
                const horizonPoints = (prediction.points || []).map((point) => ({
                    time: point.time,
                    value: point.value,
                }));
                return {
                    created: prediction.created,
                    fullPath,
                    path: fullPath,
                    horizonPoints,
                };
            })
            .filter((item) => (item.fullPath || item.path).length >= 1);
    }

    function issuanceHorizonEndMs(item) {
        const points = item?.horizonPoints || item?.path || item?.points || [];
        let end = finiteNumber(item?.created);
        points.forEach((point) => {
            const time = finiteNumber(point?.time);
            if (time === null) return;
            if (end === null || time > end) end = time;
        });
        return end;
    }

    function isIssuanceExpired(item, cursorMs) {
        const cursor = finiteNumber(cursorMs);
        const end = issuanceHorizonEndMs(item);
        if (cursor === null || end === null) return false;
        return cursor > end;
    }

    function formatSignedMb(value) {
        if (!Number.isFinite(value)) return null;
        const rounded = Math.round(value);
        if (rounded > 0) return `+${rounded} MB`;
        return `${rounded} MB`;
    }

    function formatErrorPct(predicted, actual) {
        if (!Number.isFinite(predicted) || !Number.isFinite(actual) || actual === 0) return null;
        const pct = ((predicted - actual) / Math.abs(actual)) * 100;
        const rounded = Math.abs(pct) >= 10 ? pct.toFixed(0) : pct.toFixed(1);
        return `${pct > 0 ? '+' : ''}${rounded}%`;
    }

    function horizonTooltip(item, point, elapsedS, actuals) {
        const horizonS = Math.round((point.time - item.created) / 1000);
        const actual = actualNear(actuals || [], point.time, ACTUAL_MATCH_WINDOW_MS);
        const parts = [
            `Issued at ${Math.round(elapsedS(item.created))}s`,
            `Horizon +${horizonS}s → ${Math.round(elapsedS(point.time))}s`,
            `Predicted ${Math.round(point.value)} MB`,
        ];
        if (actual) {
            const errorMb = point.value - actual.value;
            const errorPct = formatErrorPct(point.value, actual.value);
            parts.push(`Actual ${Math.round(actual.value)} MB`);
            parts.push(`Error ${formatSignedMb(errorMb)}${errorPct ? ` (${errorPct})` : ''}`);
        } else {
            parts.push('Actual pending');
        }
        return parts.join(' · ');
    }

    function forecastAccuracyByHorizon(groups) {
        const buckets = new Map([
            [10, []],
            [30, []],
            [60, []],
        ]);
        (groups || []).forEach((group) => {
            (group.predictions || []).forEach((prediction) => {
                (prediction.points || []).forEach((point) => {
                    const horizonS = Math.round((point.time - prediction.created) / 1000);
                    if (!buckets.has(horizonS)) return;
                    const actual = actualNear(group.actual || [], point.time, ACTUAL_MATCH_WINDOW_MS);
                    if (!actual || !Number.isFinite(point.value) || !Number.isFinite(actual.value)) return;
                    buckets.get(horizonS).push(point.value - actual.value);
                });
            });
        });
        return [10, 30, 60].map((horizonS) => {
            const errors = buckets.get(horizonS) || [];
            if (!errors.length) {
                return { horizonS, n: 0, mae: null, bias: null };
            }
            const abs = errors.map((value) => Math.abs(value));
            const mae = abs.reduce((sum, value) => sum + value, 0) / abs.length;
            const bias = errors.reduce((sum, value) => sum + value, 0) / errors.length;
            return { horizonS, n: errors.length, mae, bias };
        });
    }

    function renderForecastAccuracyHtml(groups) {
        const rows = forecastAccuracyByHorizon(groups).filter((row) => row.n > 0);
        if (!rows.length) return '';
        const body = rows.map((row) => (
            `<tr>`
            + `<th scope="row">+${row.horizonS}s</th>`
            + `<td>${escapeHtml(formatValue(row.mae, 'MB'))}</td>`
            + `<td>${escapeHtml(formatSignedMb(row.bias) || '—')}</td>`
            + `<td>${row.n}</td>`
            + `</tr>`
        )).join('');
        return `<div class="forecast-accuracy-table-wrap" data-forecast-accuracy>`
            + `<table class="forecast-accuracy-table" aria-label="Forecast accuracy">`
            + `<caption>Prediction accuracy</caption>`
            + `<thead><tr><th scope="col">Horizon</th><th scope="col">MAE</th><th scope="col">Bias</th><th scope="col">n</th></tr></thead>`
            + `<tbody>${body}</tbody></table></div>`;
    }

    function renderIssuancePolylineTraces(paths, xAt, yAt, elapsedS, actuals, markerPaths, options = {}) {
        const drawable = (paths || []).filter((item) => item.path.length >= 2);
        const markers = (markerPaths || paths || []).filter((item) => (item.fullPath || item.path).length >= 1);
        const cursorMs = finiteNumber(options.cursorMs);
        if (!drawable.length && !markers.length) {
            return { traces: '', horizonMarkers: '', issuanceMarkers: '' };
        }
        const traces = drawable.map((item, index) => {
            const latest = index === drawable.length - 1;
            const expired = latest && isIssuanceExpired(item, cursorMs);
            let cls = 'forecast-trace forecast-trace-issuance';
            if (!latest) cls += ' forecast-trace-prior';
            else if (expired) cls += ' forecast-trace-latest forecast-trace-expired';
            else cls += ' forecast-trace-latest';
            const points = item.path.map((point) => `${xAt(point.time)},${yAt(point.value)}`).join(' ');
            return `<polyline class="${cls}" points="${points}"/>`;
        }).join('');
        const horizonMarkers = drawable.flatMap((item, index) => {
            const latest = index === drawable.length - 1;
            const expired = latest && isIssuanceExpired(item, cursorMs);
            const horizons = item.horizonPoints || item.path.slice(1);
            return horizons.map((point) => {
                const title = horizonTooltip(item, point, elapsedS, actuals);
                let cls = 'forecast-point forecast-horizon';
                if (!latest) cls += ' forecast-horizon-prior';
                else if (expired) cls += ' forecast-horizon-expired';
                return `<circle class="${cls}" cx="${xAt(point.time)}" cy="${yAt(point.value)}" r="3.5"><title>${escapeHtml(title)}</title></circle>`;
            });
        }).join('');
        const issuanceMarkers = markers.map((item, index) => {
            const latest = index === markers.length - 1;
            const origin = (item.fullPath || item.path)[0];
            if (!origin || !Number.isFinite(origin.value)) return '';
            const expired = latest && isIssuanceExpired(item, cursorMs);
            const horizonSummary = (item.horizonPoints || [])
                .map((point) => `+${Math.round((point.time - item.created) / 1000)}s ${Math.round(point.value)} MB`)
                .join(', ');
            const title = [
                `Issued at ${Math.round(elapsedS(item.created))}s`,
                latest ? (expired ? 'Expired issuance' : 'Latest issuance') : 'Earlier issuance',
                horizonSummary || 'No horizons',
            ].join(' · ');
            let cls = 'forecast-point forecast-issuance';
            if (!latest) cls += ' forecast-issuance-prior';
            else if (expired) cls += ' forecast-issuance-expired';
            return `<circle class="${cls}" cx="${xAt(item.created)}" cy="${yAt(origin.value)}" r="5"><title>${escapeHtml(title)}</title></circle>`;
        }).join('');
        return { traces, horizonMarkers, issuanceMarkers };
    }

    function renderForecastChartSvg(group, untilMs, options = {}) {
        if (!group?.actual?.length) return '';
        const mode = String(options.predictionMode || '');
        const historyMode = normalizeIssuanceHistoryMode(options.historyMode);
        const issuanceMode = usesIssuancePolylines(mode);
        const cutoff = finiteNumber(untilMs);
        const issuancePaths = issuanceMode ? visibleIssuancePaths(group, untilMs, historyMode) : [];
        const markerPaths = issuanceMode ? revealedIssuanceMarkers(group, untilMs) : [];
        // Domain uses every revealed issuance so history-mode toggles do not jump the axes.
        const domainPaths = issuanceMode ? visibleIssuancePaths(group, untilMs, 'all') : [];
        const fullTrack = issuanceMode
            ? { observed: [], forward: [] }
            : buildTrackingSeries(group.predictions || [], group.actual);
        const trackPoints = fullTrack.observed.concat(fullTrack.forward);
        // Axis domain uses full unclipped geometry so scrubbing does not rescale the chart.
        const issuanceDomainValues = domainPaths.flatMap((item) => (
            (item.fullPath || item.path).map((point) => point.value)
        ));
        const allValues = group.actual.map((point) => point.value)
            .concat(trackPoints.flatMap((point) => [point.min, point.max, point.mid]))
            .concat(issuanceDomainValues);
        const minTime = group.actual[0].time;
        const maxTime = Math.max(
            group.actual[group.actual.length - 1].time,
            trackPoints[trackPoints.length - 1]?.time ?? group.actual[group.actual.length - 1].time,
            ...domainPaths.flatMap((item) => (item.fullPath || item.path).map((point) => point.time)),
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

        const visibleActual = cutoff === null ? group.actual : group.actual.filter((point) => point.time <= cutoff);
        const cursorTime = cutoff === null
            ? group.actual[group.actual.length - 1].time
            : Math.min(Math.max(cutoff, minTime), maxTime);
        const nowX = xAt(cursorTime);
        const actualLine = visibleActual.length
            ? `<polyline class="actual-trace" points="${visibleActual.map(xy).join(' ')}"/>`
            : '';

        let predictionLayer = '';
        let issuanceMarkers = '';
        if (issuanceMode) {
            const drawn = renderIssuancePolylineTraces(
                issuancePaths,
                xAt,
                yAt,
                elapsedS,
                group.actual,
                markerPaths,
                { cursorMs: cursorTime },
            );
            predictionLayer = `${drawn.traces}${drawn.horizonMarkers}`;
            issuanceMarkers = drawn.issuanceMarkers;
        } else {
            // Legacy non-timeline payloads: keep stitched track rendering.
            const visibleObserved = cutoff === null
                ? fullTrack.observed
                : fullTrack.observed.filter((point) => point.time <= cutoff);
            const observedSegments = splitByGaps(visibleObserved, TRACK_GAP_BREAK_MS);
            const band = observedSegments.map((segment) => areaPath(segment, xAt, yAt, 'min', 'max'))
                .filter(Boolean)
                .map((path) => `<path class="forecast-band" d="${path}"/>`)
                .join('');
            const predictionLine = observedSegments.map((segment) => {
                const points = polylinePath(segment, xAt, yAt, 'mid');
                return points ? `<polyline class="forecast-trace forecast-trace-latest" points="${points}"/>` : '';
            }).join('');
            const forwardPoints = cutoff === null
                ? (fullTrack.observed.length && fullTrack.forward.length
                    ? [fullTrack.observed[fullTrack.observed.length - 1]].concat(fullTrack.forward)
                    : fullTrack.forward)
                : [];
            const forwardLine = polylinePath(forwardPoints, xAt, yAt, 'mid');
            const forwardTrace = forwardLine
                ? `<polyline class="forecast-trace forecast-trace-forward" points="${forwardLine}"/>`
                : '';
            predictionLayer = `${band}${predictionLine}${forwardTrace}`;
            issuanceMarkers = (group.predictions || []).map((prediction) => {
                if (cutoff !== null && prediction.created > cutoff) return '';
                if (prediction.created < minTime || prediction.created > maxTime) return '';
                const origin = actualAtOrBefore(group.actual, prediction.created);
                const value = origin?.value ?? prediction.points?.[0]?.value;
                if (!Number.isFinite(value)) return '';
                const title = `Issued at ${Math.round(elapsedS(prediction.created))}s`;
                return `<circle class="forecast-point forecast-issuance" cx="${xAt(prediction.created)}" cy="${yAt(value)}" r="5"><title>${escapeHtml(title)}</title></circle>`;
            }).join('');
        }
        const midY = (plot.top + plot.bottom) / 2;
        const aria = issuanceMode
            ? 'Actual memory trajectory with per-issuance forecast horizons'
            : 'Actual memory trajectory with prediction track';
        return `<svg class="forecast-chart" viewBox="0 0 960 280" role="img" aria-label="${aria}"><rect class="chart-frame" x="${plot.left}" y="${plot.top}" width="${plot.right - plot.left}" height="${plot.bottom - plot.top}"/>${grid}${actualLine}${predictionLayer}${issuanceMarkers}<line class="forecast-now" x1="${nowX}" x2="${nowX}" y1="${plot.top}" y2="${plot.bottom}"/>${xLabels}${yLabels}<text class="chart-axis-label" x="${(plot.left + plot.right) / 2}" y="268" text-anchor="middle">Elapsed time (seconds)</text><text class="chart-axis-label" x="18" y="${midY}" text-anchor="middle" transform="rotate(-90 18 ${midY})">Memory (MB)</text></svg>`;
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

    function renderForecastChartsHtml(groups, options = {}) {
        const predictionMode = String(options.predictionMode || '');
        const historyMode = normalizeIssuanceHistoryMode(options.historyMode);
        const untilMs = Object.prototype.hasOwnProperty.call(options, 'untilMs') ? options.untilMs : null;
        return groups.map((group, index) => (
            `<article class="process-forecast process-forecast-chart" data-forecast-group-index="${index}"><h3>${escapeHtml(group.name)} · PID ${escapeHtml(group.pid)} · ${group.metric === 'heap' ? 'Heap' : 'RSS'}</h3><div class="forecast-chart-host" data-forecast-chart-host>${renderForecastChartSvg(group, untilMs, { predictionMode, historyMode })}</div></article>`
        )).join('');
    }

    function forecastPanelHelp(mode) {
        if (usesIssuancePolylines(mode)) {
            return 'Each orange marker is a forecast issuance. By default only the latest issuance\'s original +10/+30/+60 forecast is drawn; switch to Last 3 or All issuances to compare earlier forecasts. Markers still show every revealed issuance. Once the replay cursor passes a forecast\'s final +60s target it is marked expired. Replay never reveals an issuance before it was available, and forecast values do not move with the scrubber.';
        }
        return 'Live follows the latest sample and keeps the last forecast while new ones catch up. Each orange point marks when a forecast was issued.';
    }

    function forecastHistoryModeControls(historyMode) {
        const selected = normalizeIssuanceHistoryMode(historyMode);
        const option = (value, label) => {
            const active = selected === value;
            return `<button class="btn${active ? '' : ' secondary'}" type="button" data-forecast-history-mode="${value}" aria-pressed="${active ? 'true' : 'false'}">${label}</button>`;
        };
        return `<div class="forecast-toolbar-cluster forecast-history-mode" id="forecast-history-mode" role="group" aria-label="Issuance history">
            <span class="forecast-toolbar-label" id="forecast-history-mode-label">Issuances</span>
            <div class="forecast-segmented" role="radiogroup" aria-labelledby="forecast-history-mode-label">
                ${option('latest', 'Latest')}
                ${option('recent', 'Last 3')}
                ${option('all', 'All')}
            </div>
        </div>`;
    }

    function forecastPanelLegend(mode) {
        if (usesIssuancePolylines(mode)) {
            return `<ul class="forecast-chart-legend" aria-label="Chart legend"><li><span class="legend-swatch legend-actual"></span>Actual</li><li><span class="legend-swatch legend-prediction"></span>Active forecast</li><li><span class="legend-swatch legend-prediction-prior"></span>Previous issuances</li><li><span class="legend-swatch legend-prediction-expired"></span>Expired forecast</li><li><span class="legend-swatch legend-issuance"></span>Issuance</li><li><span class="legend-swatch legend-horizon"></span>Horizon point</li><li><span class="legend-swatch legend-now"></span>Replay position</li></ul>`;
        }
        return `<ul class="forecast-chart-legend" aria-label="Chart legend"><li><span class="legend-swatch legend-actual"></span>Actual</li><li><span class="legend-swatch legend-prediction"></span>Prediction</li><li><span class="legend-swatch legend-issuance"></span>Issuance</li><li><span class="legend-swatch legend-band"></span>Prediction range</li><li><span class="legend-swatch legend-now"></span>Latest sample</li></ul>`;
    }

    function renderProcessTimelines(data) {
        const timelineMode = isTimelinePredictionMode(data?.prediction_mode);
        const available = collectForecastGroups(data, { allowEmptyPredictions: timelineMode });
        if (!available.length) {
            if (!timelineMode) return '';
            const emptyMode = preferredForecastViewMode(data);
            return `<section class="prediction-panel process-forecasts" data-forecast-panel data-prediction-mode="${escapeHtml(String(data.prediction_mode || ''))}"><h2>Process memory forecasts</h2><p id="forecast-live-status" class="forecast-live-status">${escapeHtml(formatForecastStatus(data, emptyMode))}</p><p>No eligible Gradle/Kotlin process samples yet.</p>${renderForecastModelHtml(data)}</section>`;
        }
        const defaultMode = preferredForecastViewMode(data);
        if (typeof window !== 'undefined' && data?.finished === true) {
            window.__bpwForecastViewMode = 'replay';
        }
        const lagWarn = TIMELINE_LAG_WARN_S[String(data?.prediction_mode || '')] || 40;
        const freshness = forecastFreshness(data);
        const delayed = freshness.forecastCount > 0 && freshness.lagS !== null && freshness.lagS >= lagWarn;
        const waiting = freshness.forecastCount === 0;
        const defaultHistoryMode = preferredIssuanceHistoryMode();
        const replayControls = `<div class="replay-controls forecast-replay-controls" id="forecast-replay-controls" data-forecast-view-mode="${defaultMode}" data-forecast-history-mode="${defaultHistoryMode}">
            <div class="forecast-toolbar-primary">
                <div class="forecast-toolbar-cluster forecast-view-mode" role="group" aria-label="Forecast view mode">
                    <span class="forecast-toolbar-label">View</span>
                    <div class="forecast-segmented">
                        <button class="btn${defaultMode === 'live' ? '' : ' secondary'}" type="button" id="btn-forecast-view-live" data-forecast-view-mode="live" aria-pressed="${defaultMode === 'live' ? 'true' : 'false'}">Live</button>
                        <button class="btn${defaultMode === 'replay' ? '' : ' secondary'}" type="button" id="btn-forecast-view-replay" data-forecast-view-mode="replay" aria-pressed="${defaultMode === 'replay' ? 'true' : 'false'}">Replay</button>
                    </div>
                </div>
                ${forecastHistoryModeControls(defaultHistoryMode)}
                <div class="forecast-toolbar-cluster forecast-replay-transport">
                    <div class="buttons forecast-replay-buttons">
                        <button class="btn" type="button" id="btn-forecast-replay-play">Play</button>
                        <button class="btn secondary" type="button" id="btn-forecast-replay-pause">Pause</button>
                        <button class="btn secondary" type="button" id="btn-forecast-replay-reset">Reset</button>
                    </div>
                    <div class="meta" id="forecast-replay-meta">Frame 0 / 0</div>
                </div>
            </div>
            <div class="timeline forecast-replay-timeline-wrap forecast-toolbar-timeline">
                <input type="range" id="forecast-replay-timeline" aria-label="Prediction replay timeline" min="0" max="0" value="0">
                <div class="forecast-timeline-meta">
                    <div class="meta" id="forecast-replay-time-label">Elapsed: 0s</div>
                    <label class="forecast-speed-control" for="forecast-replay-speed">
                        <span class="forecast-toolbar-label">Speed</span>
                        <select id="forecast-replay-speed" aria-label="Prediction replay speed">
                            <option value="5">5x</option>
                            <option value="10">10x</option>
                            <option value="15" selected>15x</option>
                            <option value="20">20x</option>
                            <option value="30">30x</option>
                            <option value="50">50x</option>
                        </select>
                    </label>
                </div>
            </div>
        </div>`;
        const predictionMode = String(data?.prediction_mode || '');
        const sharedLegend = forecastPanelLegend(predictionMode);
        const statusClass = `forecast-live-status${delayed ? ' is-delayed' : ''}${waiting ? ' is-waiting' : ''}`;
        return `<section class="prediction-panel process-forecasts" data-forecast-panel data-prediction-mode="${escapeHtml(predictionMode)}"><h2>Process memory forecasts</h2><p id="forecast-live-status" class="${statusClass}">${escapeHtml(formatForecastStatus(data, defaultMode))}</p><p class="forecast-panel-help">${forecastPanelHelp(predictionMode)}</p>${replayControls}${sharedLegend}<div class="process-forecast-charts" aria-label="Forecast charts">${renderForecastChartsHtml(available, { predictionMode, historyMode: defaultHistoryMode })}</div>${renderForecastModelHtml(data)}${renderForecastAccuracyHtml(available)}${renderForecastLatencyHtml(data)}<script type="application/json" id="bpw-forecast-replay-data">${JSON.stringify(available).replace(/</g, '\\u003c')}</script></section>`;
    }

    function bindProcessForecastView(root, options = {}) {
        if (options.data?.prediction_target === "class_loading") return bindActivityView(root, options);
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
        const historyButtons = () => Array.from(
            controls.querySelectorAll?.('[data-forecast-history-mode]') || [],
        );

        let isPlaying = false;
        let currentFrame = 0;
        let speedMultiplier = Number(speedSelect?.value) || 15;
        let clock = null;
        let latestData = options.data || (
            options.finished === true ? { finished: true } : { finished: false }
        );
        // Root is often #prediction-panel-content; the mode attribute lives on the
        // nested panel. Without this, renderFrame falls back to legacy tracks and
        // the Issuances selector appears to do nothing.
        let predictionMode = String(
            options.predictionMode
            || latestData?.prediction_mode
            || (typeof root.getAttribute === 'function' && root.getAttribute('data-prediction-mode'))
            || root.querySelector?.('[data-prediction-mode]')?.getAttribute?.('data-prediction-mode')
            || '',
        );
        if (predictionMode && typeof root.setAttribute === 'function') {
            root.setAttribute('data-prediction-mode', predictionMode);
        }
        let mode = preferredForecastViewMode(latestData, options.initialMode);
        let historyMode = preferredIssuanceHistoryMode(
            options.historyMode || controls.dataset.forecastHistoryMode,
        );
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
            const modelHtml = renderForecastModelHtml(latestData);
            let modelNode = root.querySelector('[data-forecast-model]');
            if (modelHtml) {
                if (modelNode) modelNode.outerHTML = modelHtml;
                else if (chartsNode && chartsNode.insertAdjacentHTML) chartsNode.insertAdjacentHTML('afterend', modelHtml);
            } else if (modelNode && typeof modelNode.remove === 'function') {
                modelNode.remove();
            }
            const accuracyHtml = renderForecastAccuracyHtml(groups);
            let accuracyNode = root.querySelector('[data-forecast-accuracy]');
            const modelAnchor = root.querySelector('[data-forecast-model]');
            if (accuracyHtml) {
                if (accuracyNode) accuracyNode.outerHTML = accuracyHtml;
                else if (modelAnchor && modelAnchor.insertAdjacentHTML) modelAnchor.insertAdjacentHTML('afterend', accuracyHtml);
                else if (chartsNode && chartsNode.insertAdjacentHTML) chartsNode.insertAdjacentHTML('afterend', accuracyHtml);
            } else if (accuracyNode && typeof accuracyNode.remove === 'function') {
                accuracyNode.remove();
            }
            const latencyHtml = renderForecastLatencyHtml(latestData);
            let latencyNode = root.querySelector('[data-forecast-latency]');
            const accuracyAnchor = root.querySelector('[data-forecast-accuracy]');
            const latencyAnchor = accuracyAnchor || root.querySelector('[data-forecast-model]');
            if (latencyHtml) {
                if (latencyNode) latencyNode.outerHTML = latencyHtml;
                else if (latencyAnchor && latencyAnchor.insertAdjacentHTML) latencyAnchor.insertAdjacentHTML('afterend', latencyHtml);
                else if (chartsNode && chartsNode.insertAdjacentHTML) chartsNode.insertAdjacentHTML('afterend', latencyHtml);
            } else if (latencyNode && typeof latencyNode.remove === 'function') {
                latencyNode.remove();
            }
        }

        function applyModeChrome() {
            controls.dataset.forecastViewMode = mode;
            controls.dataset.forecastHistoryMode = historyMode;
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
            historyButtons().forEach((btn) => {
                const active = btn.getAttribute?.('data-forecast-history-mode') === historyMode;
                if (typeof btn.setAttribute === 'function') {
                    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
                }
                if (btn.classList?.toggle) {
                    btn.classList.toggle('secondary', !active);
                }
            });
            if (typeof window !== 'undefined') {
                window.__bpwForecastViewMode = mode;
                window.__bpwForecastHistoryMode = historyMode;
            }
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
                host.innerHTML = renderForecastChartSvg(group, timestamp, {
                    predictionMode,
                    historyMode,
                });
            });
            if (!opts.fromClock && clock) {
                clock.seekTo(cursorMsForFrame(currentFrame));
            }
        }

        function setHistoryMode(nextMode) {
            const resolved = normalizeIssuanceHistoryMode(nextMode);
            if (resolved === historyMode) {
                applyModeChrome();
                return;
            }
            historyMode = resolved;
            applyModeChrome();
            renderFrame(currentFrame);
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
            if (data.prediction_target === "class_loading") return false;
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
            predictionMode = String(data.prediction_mode || '');
            if (typeof root.setAttribute === 'function') {
                root.setAttribute('data-prediction-mode', predictionMode);
            }
            if (dataNode) dataNode.textContent = JSON.stringify(groups);
            if (chartsNode) chartsNode.innerHTML = renderForecastChartsHtml(groups, { predictionMode, historyMode });
            const helpNode = root.querySelector('.forecast-panel-help');
            if (helpNode) helpNode.textContent = forecastPanelHelp(predictionMode);
            const legendNode = root.querySelector('.forecast-chart-legend');
            if (legendNode) legendNode.outerHTML = forecastPanelLegend(predictionMode);
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
                getHistoryMode() { return historyMode; },
                setHistoryMode,
            };
        }

        if (liveBtn) liveBtn.addEventListener('click', () => setMode('live'));
        if (replayBtn) replayBtn.addEventListener('click', () => setMode('replay'));
        // Prefer delegation so the Issuances control keeps working across chart redraws.
        controls.addEventListener('click', (event) => {
            const target = event?.target?.closest?.('[data-forecast-history-mode]')
                || (event?.target?.getAttribute?.('data-forecast-history-mode') ? event.target : null);
            if (!target) return;
            const nextMode = target.getAttribute('data-forecast-history-mode');
            if (!nextMode) return;
            setHistoryMode(nextMode);
        });
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
            getHistoryMode() { return historyMode; },
            setHistoryMode,
        };
    }

    function bindProcessForecastReplay(root, options = {}) {
        const controller = bindProcessForecastView(root, options);
        return () => controller.stop();
    }

    // Count forecasts use their own contract and renderer, never value_mb.
    function activityGroups(data) {
        const groups = new Map();
        const ensure = (name, pid) => {
            if (!['GradleDaemon', 'KotlinCompileDaemon'].includes(name) || !pid) return null;
            const key = `${name}|${pid}`;
            if (!groups.has(key)) groups.set(key, { name, pid, actual: [], forecasts: [] });
            return groups.get(key);
        };
        for (const sample of data.samples || []) {
            const group = ensure(sample.Name, String(sample.PID || ''));
            const time = finiteNumber(sample.Timestamp);
            if (!group || time === null) continue;
            const value = finiteNumber(sample.ClassesLoaded ?? sample.classes_loaded);
            group.actual.push({ time, value: value !== null && value >= 0 ? value : null });
        }
        for (const forecast of data.process_activity_forecasts || []) {
            const group = ensure(forecast.process_name, String(forecast.pid || ''));
            if (group && forecast.metric === 'classes_loaded' && finiteNumber(forecast.created_at_ms) !== null) {
                group.forecasts.push(forecast);
            }
        }
        for (const group of groups.values()) {
            group.actual.sort((a, b) => a.time - b.time);
            group.forecasts.sort((a, b) => a.created_at_ms - b.created_at_ms);
        }
        return [...groups.values()];
    }

    function activityObserved(group, forecast, cursor) {
        const target = forecast.created_at_ms + 60000;
        const candidates = group.actual.filter(p => p.time <= cursor && Math.abs(p.time - target) <= 5000 && p.value !== null);
        candidates.sort((a, b) => Math.abs(a.time - target) - Math.abs(b.time - target));
        const point = candidates[0];
        if (!point || forecast.origin_value_count == null) return null;
        const segment = group.actual.filter(p => p.time >= forecast.created_at_ms && p.time <= point.time);
        let previous = {time: forecast.created_at_ms, value: forecast.origin_value_count};
        let previousSampleTime = null;
        for (const p of segment) {
            if (p.value === null || p.value < previous.value || p.time - previous.time > 15000 || (previousSampleTime !== null && p.time <= previousSampleTime)) return null;
            previousSampleTime = p.time;
            previous = p;
        }
        if (point.value < forecast.origin_value_count) return null;
        return point.value - forecast.origin_value_count;
    }

    function activityChart(group, cursor, history) {
        let shown = group.forecasts.filter(f => f.created_at_ms <= cursor);
        if (history === 'latest') shown = shown.slice(-1);
        if (history === 'recent') shown = shown.slice(-3);
        const points = shown.filter(f => ['ready', 'fallback'].includes(f.status)).flatMap(f => (f.points || []).map(p => ({f, p})))
            .filter(({f,p}) => f.origin_value_count != null && p.target_at_ms === f.created_at_ms + 60000
                && Number.isFinite(p.predicted_delta_count) && p.predicted_delta_count >= 0
                && Number.isFinite(p.predicted_total_count) && p.predicted_total_count >= 0);
        const actual = group.actual.filter(p => p.time <= cursor);
        const times = [...actual.map(p => p.time), ...shown.map(f => f.created_at_ms), ...points.map(({p}) => p.target_at_ms)];
        if (!times.length) return '<p>Waiting for class counters.</p>';
        const start = Math.min(...times), end = Math.max(start + 1000, ...times);
        const ymax = Math.max(1, ...actual.map(p => p.value || 0), ...points.map(({p}) => p.predicted_total_count));
        const x = t => 70 + (t - start) / (end - start) * 800;
        const y = v => 225 - v / ymax * 195;
        let paths = '', segment = [], previous = null;
        const flush = () => { if (segment.length) paths += `<polyline fill="none" stroke="#087f8c" stroke-width="2" points="${segment.join(' ')}"/>`; segment = []; };
        for (const p of actual) {
            if (p.value === null || (previous && (p.value < previous.value || p.time <= previous.time || p.time - previous.time > 15000))) flush();
            if (p.value !== null) segment.push(`${x(p.time)},${y(p.value)}`);
            previous = p;
        }
        flush();
        const forecasts = points.map(({f,p}) => `<line x1="${x(f.created_at_ms)}" y1="${y(f.origin_value_count)}" x2="${x(p.target_at_ms)}" y2="${y(p.predicted_total_count)}" stroke="${cursor > p.target_at_ms ? '#9ca3af' : '#c2410c'}" stroke-width="2" stroke-dasharray="6 4"><title>Issued ${escapeHtml(new Date(f.created_at_ms).toISOString())}; +60s: ${Math.round(p.predicted_total_count)} classes</title></line>`).join('');
        const latest = shown[shown.length - 1];
        const latestPoint = latest && points.find(({f}) => f === latest)?.p;
        const actualDelta = latestPoint ? activityObserved(group, latest, cursor) : null;
        const summary = latestPoint
            ? `<p><strong>Predicted additional classes in 60s: +${Math.round(latestPoint.predicted_delta_count).toLocaleString('en-US')}</strong></p><p>Observed increase: ${actualDelta === null ? 'Pending' : Math.round(actualDelta)} · Error (prediction − observed): ${actualDelta === null ? 'Pending' : Math.round(latestPoint.predicted_delta_count - actualDelta)} classes</p>` : '';
        return `<div class="activity-plot"><svg viewBox="0 0 960 280" role="img" aria-label="${escapeHtml(group.name)} cumulative classes loaded and 60-second forecasts"><rect x="70" y="20" width="800" height="205" fill="none" stroke="#d1d5db"/>${paths}${forecasts}<text x="65" y="20">${Math.round(ymax)}</text><text x="55" y="230">0</text><text x="10" y="140">Classes</text><text x="70" y="250">0s</text><text x="790" y="250">${Math.round((end-start)/1000)}s</text><text x="360" y="270">Seconds from first visible sample</text></svg></div>${summary}<p>Status: ${escapeHtml(latest?.status || 'waiting')} · Model: ${escapeHtml(latest?.model_version || 'Unavailable')} · Latency: ${latest?.latency_ms ? `${Math.round(latest.latency_ms)} ms` : 'Unavailable'}${latest?.fallback || latest?.status === 'fallback' ? ' · Fallback (not model inference)' : ''}</p>`;
    }

    function renderActivity(data, cursor, history = 'latest', mode) {
        const groups = activityGroups(data);
        const times = groups.flatMap(g => [...g.actual.map(p => p.time), ...g.forecasts.map(f => f.created_at_ms)]);
        const first = times.length ? Math.min(...times) : 0, last = times.length ? Math.max(...times) : first;
        cursor = Number.isFinite(cursor) ? cursor : last;
        mode = mode || (data.finished ? 'replay' : 'live');
        return `<section class="prediction-panel activity-panel" data-activity-panel><h2>Class-loading activity <small>Experimental</small></h2><p>Actual cumulative classes (solid) · +60s predicted total (dashed). TabPFN requires an available VM.</p><div id="forecast-replay-controls" class="activity-controls"><label>View <select aria-label="Class-loading view" data-activity-mode><option value="live" ${mode === 'live' ? 'selected' : ''}>Live</option><option value="replay" ${mode === 'replay' ? 'selected' : ''}>Replay</option></select></label><button type="button" data-activity-play>Play / pause</button><label>Issuances <select aria-label="Class-loading issuance history" data-activity-history><option value="latest" ${history === 'latest' ? 'selected' : ''}>Latest</option><option value="recent" ${history === 'recent' ? 'selected' : ''}>Last 3</option><option value="all" ${history === 'all' ? 'selected' : ''}>All</option></select></label><label class="activity-timeline">Class-loading replay timeline <input type="range" data-activity-cursor min="${first}" max="${last}" value="${cursor}" step="1000"></label></div><div data-forecast-chart-host>${groups.length ? groups.map(g => `<article class="process-forecast"><h3>${escapeHtml(g.name)} · PID ${escapeHtml(g.pid)}</h3>${activityChart(g, cursor, history)}</article>`).join('') : '<p>Waiting for eligible class-loading samples.</p>'}</div></section>`;
    }

    function bindActivityView(root, options) {
        let data = options.data || {}, mode = options.initialMode || (data.finished ? 'replay' : 'live');
        let history = 'latest', cursor = null, timer = null;
        const stop = () => { if (timer !== null) clearInterval(timer); timer = null; };
        const draw = () => {
            const active = root.ownerDocument?.activeElement;
            const control = active && root.contains(active) ? ['data-activity-mode', 'data-activity-history', 'data-activity-cursor', 'data-activity-play'].find(key => active.hasAttribute(key)) : null;
            root.innerHTML = renderActivity(data, cursor, history, mode);
            if (control) root.querySelector(`[${control}]`)?.focus({preventScroll: true});
        };
        const onChange = event => {
            const target = event.target;
            if (target.matches('[data-activity-history]')) history = target.value;
            if (target.matches('[data-activity-mode]')) { mode = target.value; stop(); if (mode === 'live') cursor = null; }
            if (target.matches('[data-activity-cursor]')) { mode = 'replay'; cursor = Number(target.value); stop(); }
            draw();
        };
        const onClick = event => {
            if (!event.target.closest('[data-activity-play]')) return;
            if (timer !== null) { stop(); return; }
            mode = 'replay';
            const slider = root.querySelector('[data-activity-cursor]');
            if (!slider) return;
            if (cursor === null || cursor >= Number(slider.max)) cursor = Number(slider.min);
            timer = setInterval(() => {
                const slider = root.querySelector('[data-activity-cursor]');
                if (!slider) { stop(); return; }
                cursor = Math.min(Number(slider.max), cursor + 1000); draw();
                if (cursor >= Number(slider.max)) stop();
            }, 100);
        };
        root.addEventListener('change', onChange); root.addEventListener('click', onClick); draw();
        return { update(next) { if (next.prediction_target !== 'class_loading') return false; if (next.finished && !data.finished) { mode = 'replay'; stop(); } data = next; if (mode === 'live') cursor = null; draw(); return true; },
            stop() { stop(); root.removeEventListener('change', onChange); root.removeEventListener('click', onClick); },
            seekTo(time) { stop(); mode = 'replay'; cursor = time; draw(); },
            getMode: () => mode, getHistoryMode: () => history };
    }

    function render(data, selectedWindow) {
        if (data.prediction_target === "class_loading") return {selectedWindow: null, html: renderActivity(data)};
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
        usesIssuancePolylines,
        normalizeIssuanceHistoryMode,
        preferredIssuanceHistoryMode,
        visibleIssuancePaths,
        revealedIssuanceMarkers,
        forecastAccuracyByHorizon,
        isIssuanceExpired,
        renderForecastChartSvg,
        preferredForecastViewMode,
        forecastFreshness,
        forecastLatencySummary,
        forecastModelSummary,
        formatForecastLatencySummary,
        formatForecastStatus,
        renderForecastModelHtml,
        bindProcessForecastView,
        bindProcessForecastReplay,
    };
})();
