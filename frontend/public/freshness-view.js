(function () {
    'use strict';

    const firstRenderedAtBySample = new Map();

    function finiteNumber(value) {
        if (value === null || value === undefined || value === '') return null;
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }

    function percentile(values, fraction) {
        if (!values.length) return null;
        const sorted = values.slice().sort((a, b) => a - b);
        const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
        return Math.round(sorted[index]);
    }

    function metric(values) {
        return { p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
    }

    function timingOf(sample) {
        return sample?.Freshness || sample?.freshness || null;
    }

    function summarize(samples, renderedAtUnixMs, browserFetchRenderMs, renderedAtBySample) {
        const renderedAt = finiteNumber(renderedAtUnixMs);
        const usable = (Array.isArray(samples) ? samples : []).map(sample => ({ sample, timing: timingOf(sample) }))
            .filter(({ timing }) => timing && finiteNumber(timing.collected_at_unix_ms) !== null &&
                finiteNumber(timing.backend_received_at_unix_ms) !== null &&
                finiteNumber(timing.backend_stored_at_unix_ms) !== null &&
                finiteNumber(timing.backend_storage_duration_ms) !== null);
        if (!usable.length || renderedAt === null) return null;

        const collectionToReceipt = [];
        const backendStorage = [];
        const storageToRender = [];
        const endToEnd = [];
        let clockSkewDetected = false;
        const sequencesByProcess = new Map();

        usable.forEach(({ sample, timing }) => {
            const collected = Number(timing.collected_at_unix_ms);
            const received = Number(timing.backend_received_at_unix_ms);
            const stored = Number(timing.backend_stored_at_unix_ms);
            const storageDuration = Number(timing.backend_storage_duration_ms);
            const receiptLatency = received - collected;
            const sampleRenderedAt = finiteNumber(renderedAtBySample?.get(timing.sample_id)) ?? renderedAt;
            const totalLatency = sampleRenderedAt - collected;
            collectionToReceipt.push(receiptLatency);
            backendStorage.push(storageDuration);
            storageToRender.push(sampleRenderedAt - stored);
            endToEnd.push(totalLatency);
            if (receiptLatency < -100 || totalLatency < -100 || sampleRenderedAt - stored < -100) {
                clockSkewDetected = true;
            }

            const sequence = finiteNumber(timing.sequence);
            if (sequence === null) return;
            const key = `${sample?.Name || ''}|${sample?.PID || ''}`;
            if (!sequencesByProcess.has(key)) sequencesByProcess.set(key, new Set());
            sequencesByProcess.get(key).add(sequence);
        });

        let sequenceGaps = 0;
        sequencesByProcess.forEach(sequenceSet => {
            const sequences = [...sequenceSet].sort((a, b) => a - b);
            for (let i = 1; i < sequences.length; i += 1) {
                sequenceGaps += Math.max(0, sequences[i] - sequences[i - 1] - 1);
            }
        });

        return {
            sampleCount: usable.length,
            sequenceGaps,
            clockSkewDetected,
            collectionToReceipt: metric(collectionToReceipt),
            backendStorage: metric(backendStorage),
            storageToRender: metric(storageToRender),
            endToEnd: metric(endToEnd),
            browserFetchRenderMs: Math.max(0, Math.round(finiteNumber(browserFetchRenderMs) || 0)),
        };
    }

    function formatDuration(value) {
        if (!Number.isFinite(value)) return 'N/A';
        if (Math.abs(value) >= 1000) return `${(value / 1000).toFixed(2)} s`;
        return `${Math.round(value)} ms`;
    }

    function render(samples, renderedAtUnixMs, browserFetchRenderMs) {
        const renderedAt = finiteNumber(renderedAtUnixMs);
        if (renderedAt !== null) {
            (Array.isArray(samples) ? samples : []).forEach(sample => {
                const sampleID = timingOf(sample)?.sample_id;
                if (sampleID && !firstRenderedAtBySample.has(sampleID)) {
                    firstRenderedAtBySample.set(sampleID, renderedAt);
                }
            });
        }
        const summary = summarize(samples, renderedAtUnixMs, browserFetchRenderMs, firstRenderedAtBySample);
        if (!summary) return null;
        const skew = summary.clockSkewDetected
            ? '<span class="freshness-status warning">Clock skew detected</span>'
            : '<span class="freshness-status ok">Clocks plausible</span>';
        const gaps = `${summary.sequenceGaps} sequence gap${summary.sequenceGaps === 1 ? '' : 's'}`;
        return {
            summary,
            html: `<section class="freshness-panel" aria-label="Live freshness diagnostics"><div class="freshness-panel-head"><div><span class="bpw-panel-badge">Spike telemetry</span><h2>Live freshness</h2></div><div>${skew}<span class="freshness-count">${summary.sampleCount} samples · ${gaps}</span></div></div><div class="freshness-metrics"><div><span>End-to-end p50</span><strong>${formatDuration(summary.endToEnd.p50)}</strong></div><div><span>End-to-end p95</span><strong>${formatDuration(summary.endToEnd.p95)}</strong></div><div><span>Runner → backend p95</span><strong>${formatDuration(summary.collectionToReceipt.p95)}</strong></div><div><span>Backend store p95</span><strong>${formatDuration(summary.backendStorage.p95)}</strong></div><div><span>Store → first display p95</span><strong>${formatDuration(summary.storageToRender.p95)}</strong></div><div><span>Dashboard fetch + render</span><strong>${formatDuration(summary.browserFetchRenderMs)}</strong></div></div>${summary.clockSkewDetected ? '<p class="freshness-note">Cross-host wall clocks are not synchronized; backend storage and browser fetch/render durations remain monotonic measurements.</p>' : ''}</section>`,
        };
    }

    window.BpwFreshnessView = { summarize, render };
})();
