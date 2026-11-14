(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.BpwPlaybackClock = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function prefersReducedMotion() {
        if (typeof matchMedia !== 'function') return false;
        try {
            return matchMedia('(prefers-reduced-motion: reduce)').matches;
        } catch (error) {
            return false;
        }
    }

    function lowerBoundIndex(timestamps, targetMs) {
        let low = 0;
        let high = timestamps.length;
        while (low < high) {
            const mid = (low + high) >> 1;
            if (timestamps[mid] < targetMs) low = mid + 1;
            else high = mid;
        }
        return low;
    }

    function createPlaybackClock(options) {
        const timestamps = Array.isArray(options?.timestamps)
            ? options.timestamps.filter((value) => Number.isFinite(value)).slice().sort((a, b) => a - b)
            : [];
        const onPosition = typeof options?.onPosition === 'function' ? options.onPosition : () => {};
        const onStateChange = typeof options?.onStateChange === 'function' ? options.onStateChange : () => {};
        const nowFn = typeof options?.now === 'function' ? options.now : () => performance.now();
        const raf = typeof options?.requestAnimationFrame === 'function'
            ? options.requestAnimationFrame
            : (typeof requestAnimationFrame === 'function' ? requestAnimationFrame.bind(globalThis) : (cb) => setTimeout(() => cb(nowFn()), 16));
        const caf = typeof options?.cancelAnimationFrame === 'function'
            ? options.cancelAnimationFrame
            : (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame.bind(globalThis) : clearTimeout);

        const startMs = timestamps.length ? timestamps[0] : 0;
        const endMs = timestamps.length ? timestamps[timestamps.length - 1] : 0;
        const durationMs = Math.max(0, endMs - startMs);

        let speed = Number(options?.speed) > 0 ? Number(options.speed) : 1;
        let playing = false;
        let cursorMs = 0;
        let anchorCursorMs = 0;
        let anchorWallMs = 0;
        let rafId = null;
        let generation = 0;
        let destroyed = false;
        let lastEmittedMs = null;

        function absoluteTime(elapsedMs) {
            return startMs + elapsedMs;
        }

        function sampleIndexAt(elapsedMs) {
            if (!timestamps.length) return -1;
            const absolute = absoluteTime(elapsedMs);
            const next = lowerBoundIndex(timestamps, absolute + Number.EPSILON);
            if (next <= 0) return absolute >= timestamps[0] ? 0 : -1;
            if (next >= timestamps.length) return timestamps.length - 1;
            if (timestamps[next] <= absolute) return next;
            return next - 1;
        }

        function emit(force) {
            if (destroyed) return;
            if (!force && lastEmittedMs === cursorMs) return;
            lastEmittedMs = cursorMs;
            const absolute = absoluteTime(cursorMs);
            onPosition({
                cursorMs,
                absoluteMs: absolute,
                sampleIndex: sampleIndexAt(cursorMs),
                sampleCount: timestamps.length,
                durationMs,
                playing,
                generation,
                reducedMotion: prefersReducedMotion(),
            });
        }

        function setPlaying(next) {
            if (playing === next) return;
            playing = next;
            onStateChange({ playing, cursorMs, durationMs, speed, generation });
        }

        function cancelFrame() {
            if (rafId !== null) {
                caf(rafId);
                rafId = null;
            }
        }

        function tick(nowMs) {
            if (destroyed || !playing) return;
            cursorMs = Math.min(durationMs, anchorCursorMs + (nowMs - anchorWallMs) * speed);
            emit(false);
            if (cursorMs >= durationMs) {
                cursorMs = durationMs;
                setPlaying(false);
                cancelFrame();
                emit(true);
                return;
            }
            rafId = raf(tick);
        }

        function requestFrame() {
            cancelFrame();
            if (!playing || destroyed) return;
            rafId = raf(tick);
        }

        function play() {
            if (destroyed || playing) return;
            if (durationMs <= 0) {
                cursorMs = 0;
                emit(true);
                return;
            }
            if (cursorMs >= durationMs) cursorMs = 0;
            anchorCursorMs = cursorMs;
            anchorWallMs = nowFn();
            setPlaying(true);
            emit(true);
            requestFrame();
        }

        function pause() {
            if (destroyed) return;
            cancelFrame();
            setPlaying(false);
            emit(true);
        }

        function seekTo(nextMs) {
            if (destroyed) return;
            generation += 1;
            cursorMs = Math.max(0, Math.min(durationMs, Number(nextMs) || 0));
            anchorCursorMs = cursorMs;
            anchorWallMs = nowFn();
            emit(true);
            if (playing) requestFrame();
        }

        function setSpeed(multiplier) {
            const parsed = Number(multiplier);
            if (!Number.isFinite(parsed) || parsed <= 0) return;
            speed = parsed;
            if (playing) {
                anchorCursorMs = cursorMs;
                anchorWallMs = nowFn();
            }
            onStateChange({ playing, cursorMs, durationMs, speed, generation });
        }

        function reset() {
            generation += 1;
            cancelFrame();
            setPlaying(false);
            cursorMs = 0;
            anchorCursorMs = 0;
            anchorWallMs = nowFn();
            emit(true);
        }

        function destroy() {
            destroyed = true;
            cancelFrame();
            playing = false;
        }

        return {
            play,
            pause,
            seekTo,
            setSpeed,
            reset,
            destroy,
            getState: () => ({
                playing,
                cursorMs,
                durationMs,
                speed,
                generation,
                startMs,
                endMs,
                sampleIndex: sampleIndexAt(cursorMs),
                sampleCount: timestamps.length,
            }),
            absoluteTime,
            sampleIndexAt,
        };
    }

    return {
        createPlaybackClock,
        lowerBoundIndex,
        prefersReducedMotion,
    };
}));
