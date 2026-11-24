(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.BpwReplayControls = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    const DEFAULT_SPEEDS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50];

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function normalizeSpeeds(speeds, defaultSpeed) {
        const list = (Array.isArray(speeds) && speeds.length ? speeds : DEFAULT_SPEEDS)
            .map((value) => Number(value))
            .filter((value) => Number.isFinite(value) && value > 0);
        const selected = Number(defaultSpeed) > 0 ? Number(defaultSpeed) : 15;
        if (!list.includes(selected)) list.push(selected);
        return { speeds: list.sort((a, b) => a - b), defaultSpeed: selected };
    }

    function renderReplayControls(options) {
        const opts = options || {};
        const idPrefix = String(opts.idPrefix || 'replay').replace(/[^a-zA-Z0-9_-]/g, '');
        const classNames = ['replay-controls'];
        if (opts.className) classNames.push(String(opts.className));
        if (opts.sticky) classNames.push('compare-replay-controls');
        const { speeds, defaultSpeed } = normalizeSpeeds(opts.speeds, opts.defaultSpeed);
        const timelineAria = escapeHtml(opts.timelineAriaLabel || 'Replay position');
        const speedAria = escapeHtml(opts.speedAriaLabel || 'Playback speed');
        const speedOptions = speeds.map((speed) => (
            `<option value="${speed}"${speed === defaultSpeed ? ' selected' : ''}>${speed}x</option>`
        )).join('');
        const playPressed = Object.prototype.hasOwnProperty.call(opts, 'playAriaPressed')
            ? ` aria-pressed="${opts.playAriaPressed ? 'true' : 'false'}"`
            : '';
        const extraTimeline = opts.extraTimelineHtml ? String(opts.extraTimelineHtml) : '';

        return `<div class="${classNames.join(' ')}" id="${idPrefix}-controls">
            <div class="buttons">
                <button class="btn" type="button" id="btn-${idPrefix}-play"${playPressed}>Play</button>
                <button class="btn secondary" type="button" id="btn-${idPrefix}-pause">Pause</button>
                <button class="btn secondary" type="button" id="btn-${idPrefix}-reset">Reset</button>
            </div>
            <div class="meta" id="${idPrefix}-meta">Frame 0 / 0</div>
            <div class="timeline">
                <input type="range" id="${idPrefix}-timeline" aria-label="${timelineAria}" min="0" max="0" value="0">
                <div class="meta" id="${idPrefix}-time-label">Elapsed: 0s</div>
                <div class="meta">
                    Speed:
                    <select id="${idPrefix}-speed" aria-label="${speedAria}">
                        ${speedOptions}
                    </select>
                </div>
                ${extraTimeline}
            </div>
        </div>`;
    }

    function resolveElements(root, idPrefix) {
        const scope = root && typeof root.querySelector === 'function' ? root : document;
        const controls = scope.querySelector(`#${idPrefix}-controls`) || scope;
        return {
            controls,
            timeline: controls.querySelector(`#${idPrefix}-timeline`),
            meta: controls.querySelector(`#${idPrefix}-meta`),
            timeLabel: controls.querySelector(`#${idPrefix}-time-label`),
            playBtn: controls.querySelector(`#btn-${idPrefix}-play`),
            pauseBtn: controls.querySelector(`#btn-${idPrefix}-pause`),
            resetBtn: controls.querySelector(`#btn-${idPrefix}-reset`),
            speedSelect: controls.querySelector(`#${idPrefix}-speed`),
        };
    }

    function defaultFormatMeta(position) {
        const count = position.sampleCount || 0;
        if (!count) return 'Frame 0 / 0';
        const index = Math.max(0, position.sampleIndex);
        return `Frame ${index + 1} / ${count}`;
    }

    function defaultFormatTime(position, timestamps) {
        if (!timestamps.length || position.sampleIndex < 0) return 'Elapsed: 0s';
        const first = timestamps[0];
        const absolute = Number.isFinite(position.absoluteMs)
            ? position.absoluteMs
            : timestamps[Math.max(0, position.sampleIndex)];
        const elapsedSec = Math.max(0, Math.round((absolute - first) / 1000));
        return `Elapsed: ${elapsedSec}s`;
    }

    function bindReplayControls(options) {
        const opts = options || {};
        const idPrefix = String(opts.idPrefix || 'replay').replace(/[^a-zA-Z0-9_-]/g, '');
        const timestamps = Array.isArray(opts.timestamps)
            ? opts.timestamps.filter((value) => Number.isFinite(value)).slice().sort((a, b) => a - b)
            : [];
        const els = resolveElements(opts.root, idPrefix);
        const createClock = opts.createPlaybackClock
            || root.BpwPlaybackClock?.createPlaybackClock
            || null;
        if (!createClock || !els.timeline || !els.playBtn || !els.pauseBtn || !els.resetBtn || !els.speedSelect) {
            return { destroy() {}, pause() {}, play() {}, reset() {}, seekToFrame() {}, getClock() { return null; } };
        }

        const timelineMode = opts.timelineMode === 'frame' ? 'frame' : 'duration';
        const formatMeta = typeof opts.formatMeta === 'function' ? opts.formatMeta : defaultFormatMeta;
        const formatTime = typeof opts.formatTime === 'function'
            ? opts.formatTime
            : (position) => defaultFormatTime(position, timestamps);
        const onFrame = typeof opts.onFrame === 'function' ? opts.onFrame : () => {};
        const startMs = timestamps.length ? timestamps[0] : 0;
        const durationMs = timestamps.length ? Math.max(0, timestamps[timestamps.length - 1] - startMs) : 0;

        if (timelineMode === 'frame') {
            els.timeline.min = '0';
            els.timeline.max = String(Math.max(0, timestamps.length - 1));
        } else {
            els.timeline.min = '0';
            els.timeline.max = String(Math.max(0, Math.round(durationMs)));
        }

        let lastSampleIndex = -1;
        const clock = createClock({
            timestamps,
            speed: Number(els.speedSelect.value) || Number(opts.defaultSpeed) || 15,
            now: opts.now,
            requestAnimationFrame: opts.requestAnimationFrame,
            cancelAnimationFrame: opts.cancelAnimationFrame,
            onPosition(position) {
                if (timelineMode === 'frame') {
                    els.timeline.value = String(Math.max(0, position.sampleIndex));
                } else {
                    els.timeline.value = String(Math.max(0, Math.round(position.cursorMs)));
                }
                if (els.meta) els.meta.textContent = formatMeta(position, timestamps);
                if (els.timeLabel) els.timeLabel.textContent = formatTime(position, timestamps);
                const shouldRenderFrame = timelineMode !== 'frame'
                    || position.sampleIndex !== lastSampleIndex
                    || position.playing === false;
                if (shouldRenderFrame) {
                    lastSampleIndex = position.sampleIndex;
                    onFrame(position);
                }
            },
            onStateChange: opts.onStateChange,
        });

        function pause() {
            clock.pause();
        }

        function play() {
            const state = clock.getState();
            if (state.cursorMs >= state.durationMs && state.durationMs > 0) {
                clock.reset();
            }
            clock.play();
        }

        function reset() {
            clock.reset();
        }

        function seekToFrame(frameIndex) {
            if (!timestamps.length) return;
            const index = Math.max(0, Math.min(Number(frameIndex) || 0, timestamps.length - 1));
            clock.seekTo(timestamps[index] - startMs);
        }

        els.playBtn.addEventListener('click', play);
        els.pauseBtn.addEventListener('click', pause);
        els.resetBtn.addEventListener('click', reset);
        els.timeline.addEventListener('input', () => {
            // Read before pause(): pause emits onPosition and rewrites the slider.
            const raw = Number(els.timeline.value);
            pause();
            if (timelineMode === 'frame') {
                seekToFrame(raw);
            } else {
                clock.seekTo(Number.isFinite(raw) ? raw : 0);
            }
        });
        els.speedSelect.addEventListener('change', () => {
            const parsed = Number(els.speedSelect.value);
            if (!Number.isNaN(parsed) && parsed > 0) clock.setSpeed(parsed);
        });

        const initial = opts.initialFrame;
        if (initial === 'end' || initial === 'last') {
            seekToFrame(timestamps.length - 1);
        } else if (Number.isFinite(initial)) {
            seekToFrame(initial);
        } else if (opts.initialCursorMs != null) {
            clock.seekTo(Number(opts.initialCursorMs) || 0);
        } else {
            seekToFrame(0);
        }

        return {
            destroy() {
                pause();
                if (typeof clock.destroy === 'function') clock.destroy();
            },
            pause,
            play,
            reset,
            seekToFrame,
            getClock() {
                return clock;
            },
        };
    }

    return {
        DEFAULT_SPEEDS,
        renderReplayControls,
        bindReplayControls,
    };
}));
