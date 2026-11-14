(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.BpwChartViewport = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function finiteNumber(value) {
        const number = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(number) ? number : null;
    }

    function niceCeil(value, headroom) {
        const amount = finiteNumber(value);
        const factor = finiteNumber(headroom) === null ? 1.10 : headroom;
        if (amount === null || amount <= 0) return 1;
        const padded = amount * factor;
        if (padded <= 1) return 1;
        const magnitude = Math.pow(10, Math.floor(Math.log10(padded)));
        const normalized = padded / magnitude;
        const nice = normalized <= 1 ? 1
            : normalized <= 1.5 ? 1.5
                : normalized <= 2 ? 2
                    : normalized <= 3 ? 3
                        : normalized <= 5 ? 5
                            : 10;
        return nice * magnitude;
    }

    function timeDomain(timestamps, paddingRatio) {
        const values = (Array.isArray(timestamps) ? timestamps : [])
            .map(finiteNumber)
            .filter((value) => value !== null)
            .sort((a, b) => a - b);
        if (!values.length) return { min: 0, max: 1 };
        if (values.length === 1) {
            const only = values[0];
            return { min: only - 1000, max: only + 1000 };
        }
        const min = values[0];
        const max = values[values.length - 1];
        const pad = Math.max(0, (max - min) * (finiteNumber(paddingRatio) ?? 0.02));
        return { min: min - pad, max: max + pad };
    }

    function memoryDomain(values, headroom) {
        const numbers = (Array.isArray(values) ? values : [])
            .map(finiteNumber)
            .filter((value) => value !== null && value >= 0);
        const peak = numbers.length ? Math.max(...numbers) : 0;
        return { min: 0, max: niceCeil(peak, headroom ?? 1.10) };
    }

    // Live Y axis: grow only when measured peak consumes reserved headroom.
    function growOnlyDomain(current, values, headroom) {
        const next = memoryDomain(values, headroom ?? 1.20);
        if (!current || !Number.isFinite(current.max)) return next;
        return { min: 0, max: Math.max(current.max, next.max) };
    }

    function applyFixedRanges(layout, domains) {
        const next = { ...(layout || {}) };
        if (domains?.x) {
            next.xaxis = {
                ...(next.xaxis || {}),
                range: [domains.x.min, domains.x.max],
                autorange: false,
                uirevision: domains.uirevision || next.xaxis?.uirevision || 'bpw-fixed-x',
            };
        }
        if (domains?.y) {
            next.yaxis = {
                ...(next.yaxis || {}),
                range: [domains.y.min, domains.y.max],
                autorange: false,
                uirevision: domains.uirevision || next.yaxis?.uirevision || 'bpw-fixed-y',
            };
        }
        if (domains?.uirevision) {
            next.uirevision = domains.uirevision;
        }
        return next;
    }

    // Presentation-only endpoint between adjacent samples. Never treat as measured data.
    function visualEndpoint(timestamps, values, playheadAbsoluteMs, gapLimitMs) {
        if (!Array.isArray(timestamps) || !Array.isArray(values) || timestamps.length < 2) return null;
        const playhead = finiteNumber(playheadAbsoluteMs);
        if (playhead === null) return null;
        let lower = -1;
        for (let i = 0; i < timestamps.length; i += 1) {
            if (timestamps[i] <= playhead) lower = i;
            else break;
        }
        if (lower < 0 || lower >= timestamps.length - 1) return null;
        const t0 = timestamps[lower];
        const t1 = timestamps[lower + 1];
        const y0 = finiteNumber(values[lower]);
        const y1 = finiteNumber(values[lower + 1]);
        if (y0 === null || y1 === null) return null;
        if (Number.isFinite(gapLimitMs) && (t1 - t0) > gapLimitMs) return null;
        if (playhead <= t0 || playhead >= t1) return null;
        const alpha = (playhead - t0) / (t1 - t0);
        return {
            time: playhead,
            value: y0 + alpha * (y1 - y0),
            visualOnly: true,
            lowerIndex: lower,
            upperIndex: lower + 1,
        };
    }

    function createRenderCoalescer(options) {
        const minIntervalMs = Math.max(16, finiteNumber(options?.minIntervalMs) ?? 70); // ~14 fps
        const nowFn = typeof options?.now === 'function' ? options.now : () => performance.now();
        const schedule = typeof options?.schedule === 'function'
            ? options.schedule
            : (cb, delay) => setTimeout(cb, delay);
        let pending = null;
        let lastRenderAt = Number.NEGATIVE_INFINITY;
        let timer = null;
        let generation = 0;

        function flush() {
            timer = null;
            if (!pending) return;
            const payload = pending;
            pending = null;
            lastRenderAt = nowFn();
            generation += 1;
            const current = generation;
            Promise.resolve(options.render(payload, current)).catch(() => {});
        }

        function enqueue(payload) {
            pending = payload;
            const elapsed = nowFn() - lastRenderAt;
            if (elapsed >= minIntervalMs) {
                if (timer) {
                    clearTimeout(timer);
                    timer = null;
                }
                flush();
                return;
            }
            if (timer) return;
            timer = schedule(flush, Math.max(0, minIntervalMs - elapsed));
        }

        function cancel() {
            pending = null;
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
            generation += 1;
        }

        return { enqueue, cancel, getGeneration: () => generation };
    }

    return {
        niceCeil,
        timeDomain,
        memoryDomain,
        growOnlyDomain,
        applyFixedRanges,
        visualEndpoint,
        createRenderCoalescer,
    };
}));
