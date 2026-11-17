(function () {
    const panels = {
        memory: { badge: 'Memory', title: 'Memory Usage Over Time', runChartId: 'chart', replayChartId: 'rss' },
        gc: { badge: 'GC', title: 'Garbage Collection Time', runChartId: 'gc-chart', replayChartId: 'gc' },
        'jit-time': { badge: 'JIT', title: 'Cumulative Compilation Time', runChartId: 'jit-time-chart', replayChartId: 'jit-time' },
        'jit-rate': { badge: 'JIT', title: 'Compilation Activity', runChartId: 'jit-rate-chart', replayChartId: 'jit-rate' },
        'classes-loaded': { badge: 'Classes', title: 'Cumulative Classes Loaded', runChartId: 'classes-loaded-chart', replayChartId: 'classes-loaded' },
        'class-rate': { badge: 'Classes', title: 'Class Loading Activity', runChartId: 'class-rate-chart', replayChartId: 'class-rate' },
    };

    const REPLAY_SPEEDS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50];

    function replayControlsApi() {
        return (typeof window !== 'undefined' && window.BpwReplayControls)
            || (typeof globalThis !== 'undefined' && globalThis.BpwReplayControls)
            || null;
    }

    function renderSharedReplay(options) {
        const api = replayControlsApi();
        if (!api || typeof api.renderReplayControls !== 'function') {
            throw new Error('BpwReplayControls.renderReplayControls is required');
        }
        return api.renderReplayControls(Object.assign({
            speeds: REPLAY_SPEEDS,
            defaultSpeed: 15,
        }, options));
    }

    function renderUnifiedReplay(speedOptions) {
        return `
            <div id="bpw-unified-replay" class="bpw-unified-replay" hidden>
                <div class="bpw-unified-label">Unified replay (all charts)</div>
                ${renderSharedReplay({
                    idPrefix: 'bpw-unified',
                    speeds: speedOptions || REPLAY_SPEEDS,
                    timelineAriaLabel: 'Replay position',
                    speedAriaLabel: 'Playback speed',
                })}
            </div>`;
    }

    function renderPanelReplay(panel, label, options) {
        const opts = options || {};
        const viewport = opts.viewport ? `
            <div class="meta">
                Viewport:
                <select id="${panel}-replay-viewport" aria-label="${label} replay viewport">
                    <option value="full" selected>Full timeline</option>
                    <option value="follow">Follow playback</option>
                </select>
            </div>` : '';

        return renderSharedReplay({
            idPrefix: `${panel}-replay`,
            timelineAriaLabel: `${label} replay timeline`,
            speedAriaLabel: `${label} replay speed`,
            playAriaPressed: false,
            extraTimelineHtml: viewport,
        });
    }

    function renderDownloadsToolbar(buttons) {
        return `<div class="downloads-toolbar">${buttons.map((button) => {
            const secondary = button.secondary ? ' secondary' : '';
            return `<button class="btn${secondary}" id="${button.id}">${button.label}</button>`;
        }).join('')}
                </div>`;
    }

    function runPanelContent(options) {
        // Same chrome order for every metric panel: downloads → replay → chart.
        const tools = [
            {
                key: 'memory',
                replay: options.showMemoryReplay
                    ? renderPanelReplay('rss', 'Memory', { viewport: true })
                    : '',
                insideContainer: options.showMemoryReplay
                    ? `<div class="chart-filters" id="main-chart-filters">
                    <label><input type="checkbox" id="filter-total-rss" checked> Total RSS</label>
                    <label><input type="checkbox" id="filter-rss" checked> RSS</label>
                    <label><input type="checkbox" id="filter-heap" checked> Heap</label>
                </div>`
                    : '',
                downloads: [
                    { id: 'btn-download-png', label: 'Download PNG' },
                    { id: 'btn-download-svg', label: 'Download SVG' },
                    { id: 'btn-download-json', label: 'Download JSON', secondary: true },
                    { id: 'btn-download-csv', label: 'Download CSV', secondary: true },
                ],
            },
            {
                key: 'gc',
                replay: options.showMetricReplay ? renderPanelReplay('gc', 'GC') : '',
                downloads: [
                    { id: 'btn-download-gc-png', label: 'Download GC PNG' },
                    { id: 'btn-download-gc-svg', label: 'Download GC SVG' },
                ],
            },
            {
                key: 'jit-time',
                replay: options.showMetricReplay ? renderPanelReplay('jit', 'JIT') : '',
                downloads: [
                    { id: 'btn-download-jit-png', label: 'Download JIT PNG' },
                    { id: 'btn-download-jit-svg', label: 'Download JIT SVG' },
                ],
            },
            {
                key: 'classes-loaded',
                replay: options.showMetricReplay ? renderPanelReplay('classes', 'Class loading') : '',
                downloads: [
                    { id: 'btn-download-classes-png', label: 'Download Classes PNG' },
                    { id: 'btn-download-classes-svg', label: 'Download Classes SVG' },
                ],
            },
        ];

        return tools.reduce((content, tool) => {
            content[tool.key] = {
                beforeContainer: `
                ${renderDownloadsToolbar(tool.downloads)}
                ${tool.replay}`,
            };
            if (tool.insideContainer) {
                content[tool.key].insideContainer = tool.insideContainer;
            }
            return content;
        }, {});
    }

    function chartId(panelKey, chartIdPrefix) {
        const panel = panels[panelKey];
        return chartIdPrefix
            ? `${chartIdPrefix}${panel.replayChartId}`
            : panel.runChartId;
    }

    function renderPanel(panelKey, options) {
        const panel = panels[panelKey];
        const content = options.panelContent?.[panelKey] || {};
        const height = panelKey === 'memory'
            ? options.chartHeights.memory
            : panelKey === 'gc'
                ? options.chartHeights.gc
                : options.chartHeights.runtime;
        const plotClass = panelKey === 'memory' || panelKey === 'gc' ? '' : ' class="bpw-chart-plot"';

        return `
            <section class="bpw-chart-panel" data-bpw-panel="${panelKey}" id="section-${panelKey}">
                <div class="bpw-panel-card">
                    <div class="bpw-panel-card-head">
                        <div>
                            <span class="bpw-panel-badge">${panel.badge}</span>
                            <h${options.headingLevel}>${panel.title}</h${options.headingLevel}>
                        </div>
                        <button type="button" class="bpw-panel-focus-btn" data-bpw-focus="${panelKey}" title="Expand this panel">Expand</button>
                    </div>
                    <div class="bpw-panel-card-body">
                        ${content.beforeContainer || ''}
                        <div class="chart-container">
                            ${content.insideContainer || ''}
                            <div class="chart-wrapper">
                                <div id="${chartId(panelKey, options.chartIdPrefix)}"${plotClass} style="width:100%;height:${height}px"></div>
                            </div>
                        </div>
                    </div>
                </div>
            </section>`;
    }

    function render(options) {
        const settings = {
            chartIdPrefix: options.chartIdPrefix || '',
            headingLevel: options.headingLevel === 4 ? 4 : 3,
            chartHeights: {
                memory: options.chartHeights?.memory || 500,
                gc: options.chartHeights?.gc || 500,
                runtime: options.chartHeights?.runtime || 450,
            },
            panelContent: options.includeRunControls ? runPanelContent(options) : (options.panelContent || {}),
        };
        const runtimePanels = [];

        if (options.showJIT) {
            runtimePanels.push(renderPanel('jit-time', settings), renderPanel('jit-rate', settings));
        }
        if (options.showClasses) {
            runtimePanels.push(renderPanel('classes-loaded', settings), renderPanel('class-rate', settings));
        }

        return `
            ${options.includeUnifiedReplay ? renderUnifiedReplay(options.unifiedSpeedOptions) : ''}
            <div id="bpw-workspace-deck" class="bpw-workspace-deck" hidden aria-label="Workspace layout"></div>
            <div id="bpw-chart-studio" class="bpw-chart-studio" hidden aria-label="Chart overlay studio"></div>
            <div id="bpw-build-story" class="bpw-build-story" hidden aria-label="Build story timeline"></div>
            ${options.beforeGrid || ''}
            <div id="bpw-charts-grid" class="bpw-charts-grid">
                ${renderPanel('memory', settings)}
                ${options.showGC ? renderPanel('gc', settings) : ''}
                ${runtimePanels.length ? `<div class="bpw-runtime-stage">${runtimePanels.join('')}</div>` : ''}
            </div>`;
    }

    window.BpwChartPanels = { render };
})();
