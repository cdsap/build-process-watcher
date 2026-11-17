(function () {
    const panels = {
        memory: { badge: 'Memory', title: 'Memory Usage Over Time', runChartId: 'chart', replayChartId: 'rss' },
        gc: { badge: 'GC', title: 'Garbage Collection Time', runChartId: 'gc-chart', replayChartId: 'gc' },
        'jit-time': { badge: 'JIT', title: 'Cumulative Compilation Time', runChartId: 'jit-time-chart', replayChartId: 'jit-time' },
        'jit-rate': { badge: 'JIT', title: 'Compilation Activity', runChartId: 'jit-rate-chart', replayChartId: 'jit-rate' },
        'classes-loaded': { badge: 'Classes', title: 'Cumulative Classes Loaded', runChartId: 'classes-loaded-chart', replayChartId: 'classes-loaded' },
        'class-rate': { badge: 'Classes', title: 'Class Loading Activity', runChartId: 'class-rate-chart', replayChartId: 'class-rate' },
    };

    function renderUnifiedReplay(speedOptions) {
        const speeds = speedOptions || [5, 10, 15, 20, 25, 30, 35, 40, 45, 50];
        const speedMarkup = speeds.map(speed =>
            `<option value="${speed}"${speed === 15 ? ' selected' : ''}>${speed}x</option>`
        ).join('');

        return `
            <div id="bpw-unified-replay" class="bpw-unified-replay" hidden>
                <div class="bpw-unified-label">Unified replay (all charts)</div>
                <div class="replay-controls" id="bpw-unified-replay-controls">
                    <div class="buttons">
                        <button class="btn" id="bpw-unified-play" type="button">Play</button>
                        <button class="btn secondary" id="bpw-unified-pause" type="button">Pause</button>
                        <button class="btn secondary" id="bpw-unified-reset" type="button">Reset</button>
                    </div>
                    <div class="meta" id="bpw-unified-meta">Frame 0 / 0</div>
                    <div class="timeline">
                        <input type="range" id="bpw-unified-timeline" aria-label="Replay position" min="0" max="0" value="0">
                        <div class="meta" id="bpw-unified-time-label">Elapsed: 0s</div>
                        <div class="meta">
                            Speed:
                            <select id="bpw-unified-speed" aria-label="Playback speed">${speedMarkup}</select>
                        </div>
                    </div>
                </div>
            </div>`;
    }

    const REPLAY_SPEEDS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50];

    function renderPanelReplay(panel, label, options) {
        const opts = options || {};
        // Keep Memory's follow-window control; other panels share the same chrome.
        const viewport = opts.viewport ? `
            <div class="meta">
                Viewport:
                <select id="${panel}-replay-viewport" aria-label="${label} replay viewport">
                    <option value="full" selected>Full timeline</option>
                    <option value="follow">Follow playback</option>
                </select>
            </div>` : '';

        return `
            <div class="replay-controls" id="${panel}-replay-controls">
                <div class="buttons">
                    <button class="btn" type="button" id="btn-${panel}-replay-play" aria-pressed="false">Play</button>
                    <button class="btn secondary" type="button" id="btn-${panel}-replay-pause">Pause</button>
                    <button class="btn secondary" type="button" id="btn-${panel}-replay-reset">Reset</button>
                </div>
                <div class="meta" id="${panel}-replay-meta">Frame 0 / 0</div>
                <div class="timeline">
                    <input type="range" id="${panel}-replay-timeline" aria-label="${label} replay timeline" min="0" max="0" value="0">
                    <div class="meta" id="${panel}-replay-time-label">Elapsed: 0s</div>
                    <div class="meta">
                        Speed:
                        <select id="${panel}-replay-speed" aria-label="${label} replay speed">
                            ${REPLAY_SPEEDS.map(speed =>
                                `<option value="${speed}"${speed === 15 ? ' selected' : ''}>${speed}x</option>`
                            ).join('')}
                        </select>
                    </div>
                    ${viewport}
                </div>
            </div>`;
    }

    function runPanelContent(options) {
        // Same chrome order for every metric panel: downloads → replay → chart.
        const memoryReplay = options.showMemoryReplay
            ? renderPanelReplay('rss', 'Memory', { viewport: true })
            : '';
        const memoryFilters = options.showMemoryReplay
            ? `<div class="chart-filters" id="main-chart-filters">
                    <label><input type="checkbox" id="filter-total-rss" checked> Total RSS</label>
                    <label><input type="checkbox" id="filter-rss" checked> RSS</label>
                    <label><input type="checkbox" id="filter-heap" checked> Heap</label>
                </div>`
            : '';
        const metricReplay = (panel, label) => options.showMetricReplay
            ? renderPanelReplay(panel, label, {})
            : '';

        return {
            memory: {
                beforeContainer: `
                <div class="downloads-toolbar">
                    <button class="btn" id="btn-download-png">Download PNG</button>
                    <button class="btn" id="btn-download-svg">Download SVG</button>
                    <button class="btn secondary" id="btn-download-json">Download JSON</button>
                    <button class="btn secondary" id="btn-download-csv">Download CSV</button>
                </div>
                ${memoryReplay}`,
                insideContainer: memoryFilters,
            },
            gc: {
                beforeContainer: `
                <div class="downloads-toolbar">
                    <button class="btn" id="btn-download-gc-png">Download GC PNG</button>
                    <button class="btn" id="btn-download-gc-svg">Download GC SVG</button>
                </div>
                ${metricReplay('gc', 'GC')}`,
            },
            'jit-time': {
                beforeContainer: `
                <div class="downloads-toolbar">
                    <button class="btn" id="btn-download-jit-png">Download JIT PNG</button>
                    <button class="btn" id="btn-download-jit-svg">Download JIT SVG</button>
                </div>
                ${metricReplay('jit', 'JIT')}`,
            },
            'classes-loaded': {
                beforeContainer: `
                <div class="downloads-toolbar">
                    <button class="btn" id="btn-download-classes-png">Download Classes PNG</button>
                    <button class="btn" id="btn-download-classes-svg">Download Classes SVG</button>
                </div>
                ${metricReplay('classes', 'Class loading')}`,
            },
        };
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
