(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.BpwChartSeriesStore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function finiteNumber(value) {
        const number = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(number) ? number : null;
    }

    function sampleKey(sample) {
        if (!sample || typeof sample !== 'object') return '';
        if (sample.sample_id !== undefined && sample.sample_id !== null && sample.sample_id !== '') {
            return `id:${sample.sample_id}`;
        }
        if (sample.id !== undefined && sample.id !== null && sample.id !== '') {
            return `id:${sample.id}`;
        }
        const timestamp = finiteNumber(sample.Timestamp);
        const pid = sample.PID === undefined || sample.PID === null ? '' : String(sample.PID);
        const name = sample.Name === undefined || sample.Name === null ? '' : String(sample.Name);
        const rss = finiteNumber(sample.RSS);
        const heap = finiteNumber(sample.HeapUsed);
        return `ts:${timestamp}|${name}|${pid}|rss:${rss}|heap:${heap}`;
    }

    function normalizeSamples(samples) {
        if (!Array.isArray(samples)) return [];
        const byKey = new Map();
        samples.forEach((sample) => {
            const key = sampleKey(sample);
            if (!key) return;
            byKey.set(key, sample);
        });
        return [...byKey.values()].sort((a, b) => {
            const ta = finiteNumber(a.Timestamp) ?? 0;
            const tb = finiteNumber(b.Timestamp) ?? 0;
            if (ta !== tb) return ta - tb;
            return sampleKey(a).localeCompare(sampleKey(b));
        });
    }

    function createChartSeriesStore(initialSamples) {
        let samples = normalizeSamples(initialSamples);
        const knownKeys = new Set(samples.map(sampleKey));

        function snapshot() {
            return samples.slice();
        }

        function reconcile(nextSamples) {
            const normalized = normalizeSamples(nextSamples);
            const nextKeys = new Set(normalized.map(sampleKey));
            const appended = normalized.filter((sample) => !knownKeys.has(sampleKey(sample)));
            const removed = samples.filter((sample) => !nextKeys.has(sampleKey(sample)));
            const unchanged = appended.length === 0
                && removed.length === 0
                && normalized.length === samples.length;
            samples = normalized;
            knownKeys.clear();
            normalized.forEach((sample) => knownKeys.add(sampleKey(sample)));
            return {
                samples: snapshot(),
                appended,
                removed,
                unchanged,
                count: samples.length,
            };
        }

        function append(extraSamples) {
            return reconcile(samples.concat(Array.isArray(extraSamples) ? extraSamples : []));
        }

        return {
            sampleKey,
            snapshot,
            reconcile,
            append,
            getCount: () => samples.length,
        };
    }

    return {
        sampleKey,
        normalizeSamples,
        createChartSeriesStore,
    };
}));
