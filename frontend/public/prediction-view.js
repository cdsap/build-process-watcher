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

    function render(data, selectedWindow) {
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

        return { selectedWindow: selected?.observation_window_s ?? null, html: `${summary}<section class="prediction-panel"><div class="prediction-panel-head"><div><span class="bpw-panel-badge">Evolution</span><h2>Prediction evolution</h2></div><span class="prediction-panel-meta">${ready.length} of ${checkpoints.length} ready</span></div>${timeline}</section>${details}<section class="prediction-panel prediction-evolution"><div class="prediction-panel-head"><div><span class="bpw-panel-badge">Changes</span><h2>How estimates changed</h2></div></div>${renderMetricRow('Predicted peak RSS', peakRows, 'MB')}${renderMetricRow('Predicted duration', durationRows, 's')}${riskRows || '<p>Not enough ready checkpoints to show evolution.</p>'}</section>${outcome}` };
    }

    window.BpwPredictionView = { normalizeCheckpoints, formatElapsed, formatValue, render, observedAtCheckpoint, aggregateRssAtTimestamp, peakAggregateRss };
})();
