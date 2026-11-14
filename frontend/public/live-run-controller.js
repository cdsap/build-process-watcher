(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.BpwLiveRunController = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function createLiveRunController(options) {
        const fetchImpl = typeof options?.fetch === 'function' ? options.fetch : fetch.bind(globalThis);
        const onData = typeof options?.onData === 'function' ? options.onData : () => {};
        const onError = typeof options?.onError === 'function' ? options.onError : () => {};
        const normalize = typeof options?.normalize === 'function'
            ? options.normalize
            : (payload) => payload;
        let inFlight = false;
        let generation = 0;
        let timer = null;
        let destroyed = false;
        let lastFinished = false;

        function cancelTimer() {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        }

        async function refresh(runId, backendUrl) {
            if (destroyed || inFlight) return { skipped: true, reason: 'in-flight' };
            inFlight = true;
            const token = ++generation;
            const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
            try {
                const response = await fetchImpl(`${backendUrl}/runs/${runId}`);
                if (destroyed || token !== generation) return { skipped: true, reason: 'stale' };
                if (!response.ok) {
                    onError({ runId, status: response.status, statusText: response.statusText, response });
                    return { ok: false, status: response.status };
                }
                const payload = normalize(await response.json());
                if (destroyed || token !== generation) return { skipped: true, reason: 'stale' };
                lastFinished = payload?.finished === true;
                onData({
                    runId,
                    data: payload,
                    browserRequestStarted: started,
                    generation: token,
                });
                return { ok: true, finished: lastFinished };
            } catch (error) {
                if (!destroyed && token === generation) onError({ runId, error });
                return { ok: false, error };
            } finally {
                if (token === generation) inFlight = false;
            }
        }

        function schedule(runId, backendUrl, intervalSeconds) {
            cancelTimer();
            if (destroyed || lastFinished) return;
            const delayMs = Math.max(1, Number(intervalSeconds) || 60) * 1000;
            timer = setTimeout(() => {
                refresh(runId, backendUrl).then((result) => {
                    if (!destroyed && result?.ok && !result.finished) {
                        schedule(runId, backendUrl, intervalSeconds);
                    }
                });
            }, delayMs);
        }

        function destroy() {
            destroyed = true;
            generation += 1;
            cancelTimer();
        }

        return {
            refresh,
            schedule,
            cancelTimer,
            destroy,
            isInFlight: () => inFlight,
            getGeneration: () => generation,
        };
    }

    return { createLiveRunController };
}));
