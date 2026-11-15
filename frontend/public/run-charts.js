(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.BpwRunCharts = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    let activeRunId = 'run';

    function setRunContext(options) {
        if (options && options.runId != null && String(options.runId)) {
            activeRunId = String(options.runId);
        }
        return activeRunId;
    }

    function shared() {
        return root.BpwCompareShared || {};
    }

    function plotly() {
        return root.Plotly;
    }

    function ensureChartResizeHandler() {
        if (root.__bpwChartResizeBound) return;
        root.__bpwChartResizeBound = true;
        root.addEventListener('resize', () => {
            const Plotly = plotly();
            if (!Plotly || !Plotly.Plots) return;
            ['chart', 'gc-chart', 'rss-heap-chart', 'jit-time-chart', 'jit-rate-chart', 'classes-loaded-chart', 'class-rate-chart']
                .forEach((id) => {
                    if (root.document && root.document.getElementById(id)) {
                        Plotly.Plots.resize(id);
                    }
                });
        });
    }

    function renderGCChart(samples, options = {}) {
        const CompareShared = shared();
        const Plotly = plotly();
        const {
            buildColorMap,
            applyVisibilityToTraces,
            attachLegendVisibilityHandlers,
            getGcLayout,
            getGcConfig,
        } = CompareShared;
        if (!Plotly || !buildColorMap || !getGcLayout || !getGcConfig) return;

        const timestamps = [...new Set(samples.map((s) => s.Timestamp))].sort((a, b) => a - b);
        const processKeys = [...new Set(samples.map((s) => `${s.Name}|${s.PID}`))];
        const traces = [];
        const colorMap = buildColorMap(processKeys);

        processKeys.forEach((processKey) => {
            const color = colorMap[processKey];
            const [processName, pid] = processKey.split('|');
            const gcData = timestamps.map((timestamp) => {
                const sample = samples
                    .filter((s) => s.Name === processName && s.PID === pid && s.Timestamp === timestamp)[0];
                return sample && sample.GCTime !== undefined && sample.GCTime !== null && !Number.isNaN(sample.GCTime)
                    ? sample.GCTime / 1000
                    : null;
            });
            traces.push({
                x: timestamps.map((t) => new Date(t)),
                y: gcData,
                type: 'scatter',
                mode: 'lines+markers',
                name: `${processName} PID:${pid}`,
                line: { color, width: 3 },
                marker: { size: 6, color },
                connectgaps: false,
            });
        });

        const layout = {
            ...getGcLayout(),
            uirevision: `run:${activeRunId}:panel:gc`,
        };
        const config = getGcConfig(`build-monitor-gc-${activeRunId}`);
        const prepared = applyVisibilityToTraces('gc-chart', traces);
        const node = root.document && root.document.getElementById('gc-chart');
        if (options.live && node && node.data && node.data.length) {
            Plotly.react('gc-chart', prepared, layout, config);
        } else {
            Plotly.newPlot('gc-chart', prepared, layout, config);
        }
        if (typeof attachLegendVisibilityHandlers === 'function') {
            attachLegendVisibilityHandlers('gc-chart');
        }
        ensureChartResizeHandler();
    }

    function renderRssHeapRatioChart(samples) {
        const CompareShared = shared();
        const Plotly = plotly();
        const {
            buildColorMap,
            applyVisibilityToTraces,
            attachLegendVisibilityHandlers,
            getRatioLayout,
            getRatioConfig,
        } = CompareShared;
        if (!Plotly || !buildColorMap || !getRatioLayout || !getRatioConfig) return;

        const timestamps = [...new Set(samples.map((s) => s.Timestamp))].sort((a, b) => a - b);
        const processKeys = [...new Set(samples.map((s) => `${s.Name}|${s.PID}`))];
        const traces = [];
        const colorMap = buildColorMap(processKeys);

        processKeys.forEach((processKey) => {
            const color = colorMap[processKey];
            const [processName, pid] = processKey.split('|');
            const ratioData = timestamps.map((timestamp) => {
                const sample = samples
                    .filter((s) => s.Name === processName && s.PID === pid && s.Timestamp === timestamp)[0];
                if (sample && sample.RSS && sample.RSS > 0) {
                    return sample.HeapUsed / sample.RSS;
                }
                return null;
            });
            traces.push({
                x: timestamps.map((t) => new Date(t)),
                y: ratioData,
                type: 'scatter',
                mode: 'lines+markers',
                name: `${processName} PID:${pid}`,
                line: { color, width: 3 },
                marker: { size: 6, color },
                connectgaps: false,
            });
        });

        const layout = getRatioLayout();
        const config = getRatioConfig(`build-monitor-ratio-${activeRunId}`);
        Plotly.newPlot('rss-heap-chart', applyVisibilityToTraces('rss-heap-chart', traces), layout, config);
        if (typeof attachLegendVisibilityHandlers === 'function') {
            attachLegendVisibilityHandlers('rss-heap-chart');
        }
        ensureChartResizeHandler();
    }

    return {
        setRunContext,
        ensureChartResizeHandler,
        renderGCChart,
        renderRssHeapRatioChart,
    };
}));
