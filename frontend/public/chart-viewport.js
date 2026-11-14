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

    function findGaps(timestamps, gapLimitMs) {
        const limit = finiteNumber(gapLimitMs);
        const gaps = [];
        if (limit === null || !(limit > 0) || !Array.isArray(timestamps)) return gaps;
        for (let i = 0; i < timestamps.length - 1; i += 1) {
            const start = finiteNumber(timestamps[i]);
            const end = finiteNumber(timestamps[i + 1]);
            if (start === null || end === null) continue;
            if ((end - start) > limit) {
                gaps.push({
                    lowerIndex: i,
                    upperIndex: i + 1,
                    start: start,
                    end: end,
                });
            }
        }
        return gaps;
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

    /**
     * Progressive dashed connector across an unobserved sample gap.
     * Reveals from gap.start toward min(playhead, gap.end) along the line to the next sample.
     */
    function unobservedConnectors(timestamps, values, playheadAbsoluteMs, gapLimitMs, options) {
        const playhead = finiteNumber(playheadAbsoluteMs);
        const gaps = findGaps(timestamps, gapLimitMs);
        if (playhead === null || !gaps.length || !Array.isArray(values)) return [];
        const maxIndex = options && Number.isFinite(options.maxIndex)
            ? options.maxIndex
            : timestamps.length - 1;
        const firstIndex = options && Number.isFinite(options.firstIndex) ? options.firstIndex : 0;
        const out = [];
        gaps.forEach((gap) => {
            if (gap.lowerIndex < firstIndex) return;
            if (gap.lowerIndex > maxIndex) return;
            if (playhead <= gap.start) return;
            const y0 = finiteNumber(values[gap.lowerIndex]);
            const y1 = finiteNumber(values[gap.upperIndex]);
            if (y0 === null || y1 === null) return;
            const endTime = Math.min(playhead, gap.end);
            if (!(endTime > gap.start)) return;
            const alpha = (endTime - gap.start) / (gap.end - gap.start);
            out.push({
                x: [gap.start, endTime],
                y: [y0, y0 + (y1 - y0) * alpha],
                lowerIndex: gap.lowerIndex,
                upperIndex: gap.upperIndex,
                complete: endTime >= gap.end,
            });
        });
        return out;
    }

    /**
     * Build measured x/y with null breaks at gaps so Plotly never draws a solid
     * segment across an unobserved interval.
     */
    function measuredSeriesWithGapBreaks(timestamps, values, firstIndex, endIndex, gapLimitMs) {
        if (!Array.isArray(timestamps) || !Array.isArray(values) || firstIndex < 0 || endIndex < firstIndex) {
            const fallback = Array.isArray(timestamps) && timestamps.length ? timestamps[0] : Date.now();
            return { x: [new Date(fallback)], y: [null] };
        }
        const x = [];
        const y = [];
        const limit = finiteNumber(gapLimitMs);
        for (let i = firstIndex; i <= endIndex; i += 1) {
            if (i > firstIndex && limit !== null && limit > 0) {
                const prev = finiteNumber(timestamps[i - 1]);
                const curr = finiteNumber(timestamps[i]);
                if (prev !== null && curr !== null && (curr - prev) > limit) {
                    x.push(new Date(prev));
                    y.push(null);
                }
            }
            x.push(new Date(timestamps[i]));
            y.push(finiteNumber(values[i]));
        }
        return { x: x, y: y };
    }

    function followDomain(fullDomain, playheadAbsoluteMs, windowMs, mode) {
        const full = fullDomain || { min: 0, max: 1 };
        if (mode !== 'follow') {
            return { min: full.min, max: full.max, mode: 'full' };
        }
        const playhead = finiteNumber(playheadAbsoluteMs);
        const windowSize = Math.max(1, finiteNumber(windowMs) || 1);
        if (playhead === null) {
            return { min: full.min, max: Math.min(full.max, full.min + windowSize), mode: 'follow' };
        }
        const pad = windowSize * 0.08;
        let max = Math.max(playhead + pad, full.min + windowSize);
        let min = max - windowSize;
        if (min < full.min) {
            min = full.min;
            max = Math.min(full.max, min + windowSize);
        }
        if (max > full.max) {
            max = full.max;
            min = Math.max(full.min, max - windowSize);
        }
        return { min: min, max: max, mode: 'follow' };
    }

    function applyPlayheadShape(layout, playheadAbsoluteMs) {
        const next = { ...(layout || {}) };
        const playhead = finiteNumber(playheadAbsoluteMs);
        const shapes = (next.shapes || []).filter((shape) => !(shape && shape.name === 'bpw-playhead'));
        if (playhead !== null) {
            shapes.push({
                name: 'bpw-playhead',
                type: 'line',
                xref: 'x',
                yref: 'paper',
                x0: new Date(playhead),
                x1: new Date(playhead),
                y0: 0,
                y1: 1,
                line: { color: 'rgba(44, 62, 80, 0.55)', width: 1.5, dash: 'dot' },
            });
        }
        next.shapes = shapes;
        return next;
    }

    // Plotly uses uids inside querySelector class selectors during react/cleanPlot.
    function plotlySafeUid(...parts) {
        return parts
            .map((part) => String(part == null ? '' : part))
            .join('-')
            .replace(/[^a-zA-Z0-9_-]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 120) || 'trace';
    }

    function createRenderCoalescer(options) {
        const minIntervalMs = Math.max(0, finiteNumber(options?.minIntervalMs) ?? 70); // ~14 fps when 70
        const nowFn = typeof options?.now === 'function' ? options.now : () => performance.now();
        const schedule = typeof options?.schedule === 'function'
            ? options.schedule
            : (cb, delay) => setTimeout(cb, delay);
        let pending = null;
        let lastStartedAt = Number.NEGATIVE_INFINITY;
        let timer = null;
        let generation = 0;
        let inFlight = false;

        function clearTimer() {
            if (timer != null) {
                clearTimeout(timer);
                timer = null;
            }
        }

        function runLatest() {
            if (inFlight || !pending || typeof options?.render !== 'function') return;
            const payload = pending;
            pending = null;
            clearTimer();
            lastStartedAt = nowFn();
            generation += 1;
            const token = generation;
            inFlight = true;
            Promise.resolve(options.render(payload, token))
                .catch(() => null)
                .then(() => {
                    inFlight = false;
                    if (!pending) return;
                    const wait = Math.max(0, minIntervalMs - (nowFn() - lastStartedAt));
                    if (wait > 0) {
                        timer = schedule(runLatest, wait);
                    } else {
                        runLatest();
                    }
                });
        }

        function enqueue(payload) {
            pending = payload;
            if (inFlight) return;
            const elapsed = nowFn() - lastStartedAt;
            if (elapsed >= minIntervalMs) {
                clearTimer();
                runLatest();
                return;
            }
            if (timer != null) return;
            timer = schedule(runLatest, Math.max(0, minIntervalMs - elapsed));
        }

        function cancel() {
            pending = null;
            clearTimer();
            generation += 1;
        }

        return {
            enqueue: enqueue,
            cancel: cancel,
            getGeneration: function () { return generation; },
            isInFlight: function () { return inFlight; },
        };
    }

    return {
        niceCeil: niceCeil,
        timeDomain: timeDomain,
        memoryDomain: memoryDomain,
        growOnlyDomain: growOnlyDomain,
        applyFixedRanges: applyFixedRanges,
        findGaps: findGaps,
        visualEndpoint: visualEndpoint,
        unobservedConnectors: unobservedConnectors,
        measuredSeriesWithGapBreaks: measuredSeriesWithGapBreaks,
        followDomain: followDomain,
        applyPlayheadShape: applyPlayheadShape,
        plotlySafeUid: plotlySafeUid,
        createRenderCoalescer: createRenderCoalescer,
    };
}));
