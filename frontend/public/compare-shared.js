(function (global) {
    const COLOR_PALETTE = [
        '#087f8c',
        '#c9513d',
        '#b88414',
        '#247b5b',
        '#4f5d95',
        '#9a4d74',
        '#6f5b3e',
        '#2f7f6f'
    ];

    const visibilityStore = {};

    function applyVisibilityToTraces(chartId, traces) {
        const map = visibilityStore[chartId];
        if (!map) return traces;
        traces.forEach(trace => {
            if (trace && trace.name && map[trace.name] !== undefined) {
                trace.visible = map[trace.name];
            }
        });
        return traces;
    }

    function attachLegendVisibilityHandlers(chartId, onUpdate) {
        const chart = document.getElementById(chartId);
        if (!chart || chart.__visibilityHandlersAttached) return;
        chart.on('plotly_restyle', (eventData) => {
            const update = eventData[0];
            const indices = eventData[1];
            if (!update || update.visible === undefined) return;
            const vis = update.visible;
            const map = visibilityStore[chartId] || (visibilityStore[chartId] = {});
            indices.forEach((traceIndex, idx) => {
                const trace = chart.data && chart.data[traceIndex];
                if (!trace || !trace.name) return;
                map[trace.name] = Array.isArray(vis) ? vis[idx] : vis;
            });
            if (typeof onUpdate === 'function') {
                onUpdate();
            }
        });
        chart.__visibilityHandlersAttached = true;
    }

    function hasGCData(samples) {
        return samples.some(sample => {
            if (sample.GCTimeSeconds !== undefined && sample.GCTimeSeconds !== null) {
                return !Number.isNaN(sample.GCTimeSeconds);
            }
            return sample.GCTime !== undefined && sample.GCTime !== null && !Number.isNaN(sample.GCTime);
        });
    }

    function hasRatioData(samples) {
        return samples.some(sample => sample && sample.RSS && sample.RSS > 0);
    }

    function isValidMetric(value) {
        return value !== null && value !== undefined && Number.isFinite(Number(value));
    }

    function hasJITData(samples) {
        return samples.some(sample => isValidMetric(sample?.JITCompilationTimeMs) || isValidMetric(sample?.JITCompiledMethods));
    }

    function hasClassLoadingData(samples) {
        return samples.some(sample => isValidMetric(sample?.ClassesLoaded) || isValidMetric(sample?.ClassLoadTimeMs));
    }

    function buildColorMap(processKeys, palette = COLOR_PALETTE) {
        const colorMap = {};
        processKeys.forEach((processKey, index) => {
            colorMap[processKey] = palette[index % palette.length];
        });
        return colorMap;
    }

    function getMedianDelta(timestamps) {
        if (!timestamps || timestamps.length < 2) return 0;
        const deltas = [];
        for (let i = 1; i < timestamps.length; i += 1) {
            deltas.push(timestamps[i] - timestamps[i - 1]);
        }
        deltas.sort((a, b) => a - b);
        const mid = Math.floor(deltas.length / 2);
        return deltas.length % 2 === 0 ? (deltas[mid - 1] + deltas[mid]) / 2 : deltas[mid];
    }

    function buildTotalRssSeries(samples, timestamps, processKeys) {
        const lastKnown = {};
        const lastSeen = {};
        const cursors = {};
        const perProcessSamples = {};

        processKeys.forEach(processKey => {
            lastKnown[processKey] = 0;
            lastSeen[processKey] = 0;
            cursors[processKey] = 0;
            const [processName, pid] = processKey.split('|');
            perProcessSamples[processKey] = samples
                .filter(s => s.Name === processName && s.PID === pid)
                .sort((a, b) => a.Timestamp - b.Timestamp);
        });

        const medianDelta = getMedianDelta(timestamps);
        const maxGap = medianDelta ? medianDelta * 2 : 0;
        const DROP_THRESHOLD = 0.2;
        const MIN_PEAK_MB = 500;
        const totalRss = [];
        const distribution = [];
        let peakTotal = 0;
        let lastDistribution = 'No data';
        let buildEndIndex = -1;

        timestamps.forEach((timestamp, i) => {
            let total = 0;
            const included = {};

            processKeys.forEach(processKey => {
                const list = perProcessSamples[processKey];
                let cursor = cursors[processKey];
                while (cursor < list.length && list[cursor].Timestamp <= timestamp) {
                    const sample = list[cursor];
                    if (sample.RSS && sample.RSS > 0) {
                        lastKnown[processKey] = sample.RSS;
                    } else {
                        lastKnown[processKey] = 0;
                    }
                    lastSeen[processKey] = sample.Timestamp;
                    cursor += 1;
                }
                cursors[processKey] = cursor;

                const recentlySeen = maxGap > 0 && lastSeen[processKey] > 0 && (timestamp - lastSeen[processKey]) <= maxGap;
                if (lastKnown[processKey] > 0 && (recentlySeen || lastSeen[processKey] === timestamp)) {
                    total += lastKnown[processKey];
                    included[processKey] = lastKnown[processKey];
                }
            });

            if (total > 0) {
                peakTotal = Math.max(peakTotal, total);
                if (buildEndIndex === -1 && peakTotal >= MIN_PEAK_MB && total < DROP_THRESHOLD * peakTotal) {
                    buildEndIndex = i;
                }
                totalRss.push(total);
                const lines = [];
                processKeys.forEach(processKey => {
                    const rss = included[processKey];
                    if (!rss) return;
                    const [processName, pid] = processKey.split('|');
                    const percent = ((rss / total) * 100).toFixed(1);
                    lines.push(`${processName} PID:${pid}: ${percent}%`);
                });
                lastDistribution = lines.join('<br>');
                distribution.push(lastDistribution);
            } else if (peakTotal > 0) {
                if (buildEndIndex === -1 && peakTotal >= MIN_PEAK_MB) {
                    buildEndIndex = i;
                }
                totalRss.push(null);
                distribution.push(lastDistribution);
            } else {
                totalRss.push(null);
                distribution.push('No data');
            }
        });

        return { totalRss, distribution, buildEndIndex };
    }

    function buildForwardFilledSeries(samples, timestamps, processName, pid, valueSelector, maxGapOverride) {
        const filtered = samples
            .filter(s => s.Name === processName && s.PID === pid)
            .sort((a, b) => a.Timestamp - b.Timestamp);
        const values = [];
        let idx = 0;
        let lastValue = null;
        let lastSeen = 0;
        const medianDelta = getMedianDelta(timestamps);
        const maxGap = maxGapOverride !== undefined ? maxGapOverride : (medianDelta ? medianDelta * 2 : 0);

        for (const timestamp of timestamps) {
            while (idx < filtered.length && filtered[idx].Timestamp <= timestamp) {
                const candidate = valueSelector(filtered[idx]);
                if (candidate !== null && candidate !== undefined) {
                    lastValue = candidate;
                }
                lastSeen = filtered[idx].Timestamp;
                idx += 1;
            }

            if (maxGap > 0 && lastSeen > 0 && (timestamp - lastSeen) > maxGap) {
                lastValue = null;
            }

            values.push(lastValue);
        }
        return values;
    }

    function buildExactSeries(samples, timestamps, processName, pid, valueSelector) {
        const byTimestamp = new Map();
        samples.forEach(sample => {
            if (sample.Name === processName && sample.PID === pid) {
                byTimestamp.set(sample.Timestamp, valueSelector(sample));
            }
        });
        return timestamps.map(timestamp => {
            const value = byTimestamp.get(timestamp);
            return value === undefined ? null : value;
        });
    }

    function buildCounterSeries(samples, timestamps, processName, pid, valueSelector) {
        const observations = samples
            .filter(sample => sample.Name === processName && sample.PID === pid)
            .map(sample => ({ timestamp: sample.Timestamp, value: valueSelector(sample) }))
            .filter(point => isValidMetric(point.value))
            .map(point => ({ ...point, value: Number(point.value) }))
            .sort((a, b) => a.timestamp - b.timestamp);
        const rateObservations = [];
        let previous = null;
        observations.forEach(point => {
            if (previous) {
                const elapsedSeconds = (point.timestamp - previous.timestamp) / 1000;
                if (elapsedSeconds > 0 && point.value >= previous.value) {
                    rateObservations.push({
                        timestamp: point.timestamp,
                        value: (point.value - previous.value) / elapsedSeconds
                    });
                }
            }
            previous = point;
        });

        let displayValue = null;
        let observationIndex = 0;
        let rateIndex = 0;
        let lastRate = null;
        let lastRateTimestamp = 0;
        const medianDelta = getMedianDelta(timestamps);
        const maxGap = medianDelta ? medianDelta * 2 : 0;
        return {
            observations,
            cumulative: timestamps.map(timestamp => {
                while (observationIndex < observations.length && observations[observationIndex].timestamp <= timestamp) {
                    displayValue = observations[observationIndex].value;
                    observationIndex += 1;
                }
                return displayValue;
            }),
            rate: timestamps.map(timestamp => {
                while (rateIndex < rateObservations.length && rateObservations[rateIndex].timestamp <= timestamp) {
                    lastRate = rateObservations[rateIndex].value;
                    lastRateTimestamp = rateObservations[rateIndex].timestamp;
                    rateIndex += 1;
                }
                if (lastRateTimestamp === timestamp || (maxGap > 0 && lastRateTimestamp > 0 && (timestamp - lastRateTimestamp) <= maxGap)) {
                    return lastRate;
                }
                return null;
            })
        };
    }

    function buildReplayData(samples, timestamps, palette = COLOR_PALETTE) {
        const processKeys = [...new Set(samples.map(s => `${s.Name}|${s.PID}`))];
        const colorMap = buildColorMap(processKeys, palette);
        const series = {};

        processKeys.forEach(processKey => {
            const [processName, pid] = processKey.split('|');
            const rss = buildForwardFilledSeries(samples, timestamps, processName, pid, s => s.RSS);
            const heap = buildForwardFilledSeries(samples, timestamps, processName, pid, s => s.HeapUsed);
            const gc = buildForwardFilledSeries(samples, timestamps, processName, pid, s => {
                const gcSeconds = s.GCTimeSeconds ?? (s.GCTime !== null && s.GCTime !== undefined && !Number.isNaN(s.GCTime)
                    ? s.GCTime / 1000
                    : null);
                return gcSeconds === null || Number.isNaN(gcSeconds) ? null : gcSeconds;
            }, Number.POSITIVE_INFINITY);
            const ratio = buildExactSeries(samples, timestamps, processName, pid, s => {
                if (!s.RSS || s.RSS <= 0) return null;
                return s.HeapUsed / s.RSS;
            });
            const jitTime = buildCounterSeries(samples, timestamps, processName, pid, s => isValidMetric(s.JITCompilationTimeMs) ? s.JITCompilationTimeMs / 1000 : null);
            const jitActivity = buildCounterSeries(samples, timestamps, processName, pid, s => s.JITCompiledMethods);
            const classes = buildCounterSeries(samples, timestamps, processName, pid, s => s.ClassesLoaded);

            series[processKey] = {
                processName,
                pid,
                color: colorMap[processKey],
                rss,
                heap,
                gc,
                ratio,
                jitTime: jitTime.cumulative,
                jitRate: jitActivity.rate,
                classesLoaded: classes.cumulative,
                classRate: classes.rate,
                firstRss: rss.findIndex(value => value !== null),
                firstGc: gc.findIndex(value => value !== null),
                firstRatio: ratio.findIndex(value => value !== null),
                firstJitTime: jitTime.cumulative.findIndex(value => value !== null),
                firstJitRate: jitActivity.rate.findIndex(value => value !== null),
                firstClassesLoaded: classes.cumulative.findIndex(value => value !== null),
                firstClassRate: classes.rate.findIndex(value => value !== null)
            };
        });

        const totalSeries = buildTotalRssSeries(samples, timestamps, processKeys);
        const { totalRss, distribution, buildEndIndex } = totalSeries;

        let finalTimestamps = timestamps;
        let finalSeries = series;
        let finalTotalRss = totalRss;
        let finalDistribution = distribution;

        if (buildEndIndex >= 0 && buildEndIndex < timestamps.length) {
            finalTimestamps = timestamps.slice(0, buildEndIndex);
            finalTotalRss = totalRss.slice(0, buildEndIndex);
            finalDistribution = distribution.slice(0, buildEndIndex);
            finalSeries = {};
            processKeys.forEach(processKey => {
                const def = series[processKey];
                finalSeries[processKey] = {
                    ...def,
                    rss: def.rss.slice(0, buildEndIndex),
                    heap: def.heap.slice(0, buildEndIndex),
                    gc: def.gc.slice(0, buildEndIndex),
                    ratio: def.ratio.slice(0, buildEndIndex),
                    jitTime: def.jitTime.slice(0, buildEndIndex),
                    jitRate: def.jitRate.slice(0, buildEndIndex),
                    classesLoaded: def.classesLoaded.slice(0, buildEndIndex),
                    classRate: def.classRate.slice(0, buildEndIndex),
                    firstRss: def.firstRss >= buildEndIndex ? -1 : def.firstRss,
                    firstGc: def.firstGc >= buildEndIndex ? -1 : def.firstGc,
                    firstRatio: def.firstRatio >= buildEndIndex ? -1 : def.firstRatio,
                    firstJitTime: def.firstJitTime >= buildEndIndex ? -1 : def.firstJitTime,
                    firstJitRate: def.firstJitRate >= buildEndIndex ? -1 : def.firstJitRate,
                    firstClassesLoaded: def.firstClassesLoaded >= buildEndIndex ? -1 : def.firstClassesLoaded,
                    firstClassRate: def.firstClassRate >= buildEndIndex ? -1 : def.firstClassRate
                };
            });
        }

        return {
            processKeys,
            series: finalSeries,
            timestamps: finalTimestamps,
            totalRss: finalTotalRss,
            totalRssDistribution: finalDistribution,
            firstTotalRssIndex: finalTotalRss.findIndex(value => value !== null)
        };
    }

    function getMaxHeapGiB(vmFlags) {
        if (!Array.isArray(vmFlags)) return null;
        const flag = vmFlags.find(entry => entry.startsWith('-XX:MaxHeapSize='));
        if (!flag) return null;
        const value = Number(flag.split('=')[1]);
        if (!Number.isFinite(value) || value <= 0) return null;
        const gib = value / (1024 * 1024 * 1024);
        return gib.toFixed(2);
    }

    function buildProcessSummary(samples, processInfo) {
        const byPid = {};
        const byName = {};
        let overallMaxRss = 0;

        if (!processInfo || typeof processInfo !== 'object') {
            return { byPid, byName, overallMaxRss };
        }

        for (const [pid, info] of Object.entries(processInfo)) {
            const processSamples = samples.filter(s => s.PID === pid);
            let maxRss = 0;
            let maxHeap = 0;
            let maxGCTimeSeconds = 0;
            let finalCompiledMethods = null;
            let finalJITTimeMs = null;
            let finalClassesLoaded = null;
            let minTimestamp = Number.POSITIVE_INFINITY;
            let maxTimestamp = 0;

            processSamples.forEach(sample => {
                if (sample.RSS && sample.RSS > maxRss) {
                    maxRss = sample.RSS;
                }
                if (sample.HeapUsed && sample.HeapUsed > maxHeap) {
                    maxHeap = sample.HeapUsed;
                }
                if (sample.GCTime) {
                    const gcSeconds = sample.GCTime / 1000;
                    if (gcSeconds > maxGCTimeSeconds) {
                        maxGCTimeSeconds = gcSeconds;
                    }
                }
                if (isValidMetric(sample.JITCompiledMethods)) finalCompiledMethods = Number(sample.JITCompiledMethods);
                if (isValidMetric(sample.JITCompilationTimeMs)) finalJITTimeMs = Number(sample.JITCompilationTimeMs);
                if (isValidMetric(sample.ClassesLoaded)) finalClassesLoaded = Number(sample.ClassesLoaded);
                if (sample.Timestamp && sample.Timestamp < minTimestamp) {
                    minTimestamp = sample.Timestamp;
                }
                if (sample.Timestamp && sample.Timestamp > maxTimestamp) {
                    maxTimestamp = sample.Timestamp;
                }
            });

            const vmFlags = Array.isArray(info?.vm_flags) ? info.vm_flags : [];
            const heapMaxGiB = getMaxHeapGiB(vmFlags);
            const durationSeconds = Number.isFinite(minTimestamp) && maxTimestamp >= minTimestamp
                ? Math.max(0, (maxTimestamp - minTimestamp) / 1000)
                : 0;

            byPid[pid] = {
                pid,
                name: info?.name || 'Unknown',
                vmFlags,
                heapMaxGiB,
                maxRss,
                maxHeap,
                totalGCTime: maxGCTimeSeconds,
                durationSeconds,
                finalCompiledMethods,
                finalJITTimeMs,
                finalClassesLoaded
            };
        }

        Object.values(byPid).forEach(entry => {
            const name = entry.name || 'Unknown';
            if (!byName[name]) {
                byName[name] = {
                    name,
                    heapMaxGiB: entry.heapMaxGiB ? Number(entry.heapMaxGiB) : null,
                    maxRss: entry.maxRss || 0,
                    maxHeap: entry.maxHeap || 0,
                    totalGCTime: entry.totalGCTime || 0,
                    durationSeconds: entry.durationSeconds || 0,
                    finalCompiledMethods: entry.finalCompiledMethods,
                    finalJITTimeMs: entry.finalJITTimeMs,
                    finalClassesLoaded: entry.finalClassesLoaded,
                    vmFlags: [...new Set(entry.vmFlags || [])],
                    pids: entry.pid ? [entry.pid] : []
                };
                return;
            }
            byName[name].maxRss = Math.max(byName[name].maxRss, entry.maxRss || 0);
            byName[name].maxHeap = Math.max(byName[name].maxHeap, entry.maxHeap || 0);
            byName[name].totalGCTime = Math.max(byName[name].totalGCTime, entry.totalGCTime || 0);
            byName[name].durationSeconds = Math.max(byName[name].durationSeconds || 0, entry.durationSeconds || 0);
            if (entry.finalCompiledMethods !== null) byName[name].finalCompiledMethods = Math.max(byName[name].finalCompiledMethods ?? 0, entry.finalCompiledMethods);
            if (entry.finalJITTimeMs !== null) byName[name].finalJITTimeMs = Math.max(byName[name].finalJITTimeMs ?? 0, entry.finalJITTimeMs);
            if (entry.finalClassesLoaded !== null) byName[name].finalClassesLoaded = Math.max(byName[name].finalClassesLoaded ?? 0, entry.finalClassesLoaded);
            if (entry.heapMaxGiB) {
                const value = Number(entry.heapMaxGiB);
                if (!Number.isNaN(value)) {
                    byName[name].heapMaxGiB = Math.max(byName[name].heapMaxGiB || 0, value);
                }
            }
            const mergedFlags = new Set([...(byName[name].vmFlags || []), ...(entry.vmFlags || [])]);
            byName[name].vmFlags = [...mergedFlags];
            if (entry.pid && !byName[name].pids.includes(entry.pid)) {
                byName[name].pids.push(entry.pid);
            }
        });

        if (samples && samples.length) {
            const timestamps = [...new Set(samples.map(s => s.Timestamp))].sort((a, b) => a - b);
            const processKeys = [...new Set(samples.map(s => `${s.Name}|${s.PID}`))];
            const totalSeries = buildTotalRssSeries(samples, timestamps, processKeys);
            totalSeries.totalRss.forEach(value => {
                if (value && value > overallMaxRss) {
                    overallMaxRss = value;
                }
            });
        }

        return { byPid, byName, overallMaxRss };
    }

    function buildMetricTraces(data, timestamps, frameIndex, metric, style, xValues) {
        const lineWidth = style?.lineWidth ?? 3;
        const heapLineWidth = style?.heapLineWidth ?? 2;
        const markerSize = style?.markerSize ?? 6;
        const heapDash = style?.heapDash ?? 'dash';
        const lineDash = style?.lineDash ?? 'solid';
        const lineOpacity = style?.lineOpacity ?? 1;
        const markerOpacity = style?.markerOpacity ?? 1;
        const includeTotalRss = style?.includeTotalRss ?? false;
        const totalLabel = style?.totalLabel ?? 'Total RSS Memory';
        const totalColor = style?.totalColor ?? '#2c3e50';
        const frameTimestamps = xValues
            ? xValues.slice(0, frameIndex + 1)
            : timestamps.slice(0, frameIndex + 1).map(t => new Date(t));
        const traces = [];
        data.processKeys.forEach(processKey => {
            const def = data.series[processKey];
            const metricMap = {
                gc: ['firstGc', 'gc'],
                ratio: ['firstRatio', 'ratio'],
                jitTime: ['firstJitTime', 'jitTime'],
                jitRate: ['firstJitRate', 'jitRate'],
                classesLoaded: ['firstClassesLoaded', 'classesLoaded'],
                classRate: ['firstClassRate', 'classRate']
            };
            const [firstKey, valueKey] = metricMap[metric] || ['firstRss', 'rss'];
            const firstIndex = def[firstKey];
            if (firstIndex === -1 || frameIndex < firstIndex) return;
            if (metric === 'rss') {
                traces.push({
                    x: frameTimestamps,
                    y: def.rss.slice(0, frameIndex + 1),
                    type: 'scatter',
                    mode: 'lines',
                    name: `${def.processName} PID:${def.pid} (RSS)`,
                    line: { color: def.color, width: lineWidth, dash: lineDash },
                    opacity: lineOpacity,
                    connectgaps: false
                });
                traces.push({
                    x: frameTimestamps,
                    y: def.heap.slice(0, frameIndex + 1),
                    type: 'scatter',
                    mode: 'lines',
                    name: `${def.processName} PID:${def.pid} (Heap)`,
                    line: { color: def.color, width: heapLineWidth, dash: heapDash },
                    opacity: lineOpacity,
                    connectgaps: false
                });
                return;
            }
            traces.push({
                x: frameTimestamps,
                y: def[valueKey].slice(0, frameIndex + 1),
                type: 'scatter',
                mode: 'lines+markers',
                name: `${def.processName} PID:${def.pid}`,
                line: { color: def.color, width: lineWidth, dash: lineDash },
                marker: { size: markerSize, color: def.color, opacity: markerOpacity },
                opacity: lineOpacity,
                connectgaps: false
            });
        });

        if (metric === 'rss' && includeTotalRss && data.totalRss) {
            const firstIndex = data.firstTotalRssIndex ?? -1;
            if (firstIndex !== -1 && frameIndex >= firstIndex) {
                traces.push({
                    x: frameTimestamps,
                    y: data.totalRss.slice(0, frameIndex + 1),
                    type: 'scatter',
                    mode: 'lines',
                    name: totalLabel,
                    line: { color: totalColor, width: lineWidth + 1, dash: lineDash },
                    opacity: lineOpacity,
                    connectgaps: false,
                    customdata: data.totalRssDistribution ? data.totalRssDistribution.slice(0, frameIndex + 1) : [],
                    hovertemplate: 'Total RSS: %{y} MB<br>%{customdata}<extra></extra>'
                });
            }
        }
        return traces;
    }

    const METRIC_CATALOG = {
        rss: { label: 'Memory', yTitle: 'Memory (MB)', color: '#087f8c' },
        gc: { label: 'GC time', yTitle: 'GC Time (s)', color: '#087f8c' },
        ratio: { label: 'Heap/RSS', yTitle: 'Heap/RSS Ratio', color: '#087f8c' },
        jitTime: { label: 'JIT time', yTitle: 'Compilation Time (s)', color: '#b88414' },
        jitRate: { label: 'JIT rate', yTitle: 'Compiled Methods / s', color: '#b88414' },
        classesLoaded: { label: 'Classes loaded', yTitle: 'Classes Loaded', color: '#247b5b' },
        classRate: { label: 'Class rate', yTitle: 'Classes / s', color: '#247b5b' }
    };

    const OVERLAY_PRESETS = {
        'memory-gc': { a: 'rss', b: 'gc', label: 'Memory + GC' },
        'memory-ratio': { a: 'rss', b: 'ratio', label: 'Memory + Heap/RSS' },
        'jit-duo': { a: 'jitTime', b: 'jitRate', label: 'JIT overlay' },
        'classes-duo': { a: 'classesLoaded', b: 'classRate', label: 'Classes overlay' },
        'gc-jit': { a: 'gc', b: 'jitRate', label: 'GC + JIT activity' }
    };

    function getAvailableOverlayMetrics(samples) {
        const metrics = ['rss'];
        if (hasGCData(samples)) metrics.push('gc');
        if (hasRatioData(samples)) metrics.push('ratio');
        if (hasJITData(samples)) metrics.push('jitTime', 'jitRate');
        if (hasClassLoadingData(samples)) metrics.push('classesLoaded', 'classRate');
        return metrics;
    }

    function buildOverlayTraces(data, timestamps, frameIndex, metricA, metricB, xValues, styleOverrides) {
        const x = xValues
            ? xValues.slice(0, frameIndex + 1)
            : timestamps.slice(0, frameIndex + 1).map(t => new Date(t));
        const traces = [];
        const catA = METRIC_CATALOG[metricA] || { label: metricA, color: '#087f8c' };
        const catB = METRIC_CATALOG[metricB] || { label: metricB, color: '#c9513d' };

        if (metricA) {
            const styleA = {
                lineWidth: 2.5,
                lineOpacity: 0.95,
                includeTotalRss: metricA === 'rss',
                ...styleOverrides?.a
            };
            buildMetricTraces(data, timestamps, frameIndex, metricA, styleA, xValues).forEach((trace) => {
                traces.push({
                    ...trace,
                    yaxis: 'y',
                    legendgroup: 'layer-a',
                    name: trace.name ? `${catA.label} · ${trace.name}` : catA.label,
                    line: { ...trace.line, color: trace.line?.color || catA.color }
                });
            });
        }

        if (metricB && metricB !== metricA) {
            const styleB = {
                lineWidth: 2,
                lineDash: 'dot',
                lineOpacity: 0.88,
                includeTotalRss: metricB === 'rss',
                ...styleOverrides?.b
            };
            buildMetricTraces(data, timestamps, frameIndex, metricB, styleB, xValues).forEach((trace) => {
                traces.push({
                    ...trace,
                    yaxis: 'y2',
                    legendgroup: 'layer-b',
                    name: trace.name ? `${catB.label} · ${trace.name}` : catB.label,
                    line: { ...trace.line, color: trace.line?.color || catB.color }
                });
            });
        }

        return traces;
    }

    function getOverlayLayout(metricA, metricB, options) {
        const catA = METRIC_CATALOG[metricA] || { yTitle: metricA, color: '#087f8c' };
        const catB = metricB && metricB !== metricA
            ? (METRIC_CATALOG[metricB] || { yTitle: metricB, color: '#c9513d' })
            : null;
        const isMobile = window.innerWidth < 768;
        const base = getMemoryLayout();
        const layout = {
            ...base,
            title: options?.title || '',
            showlegend: true,
            legend: {
                orientation: 'h',
                x: 0,
                y: isMobile ? -0.35 : -0.28,
                xanchor: 'left',
                font: { size: isMobile ? 9 : 10 }
            },
            margin: {
                l: isMobile ? 52 : 64,
                r: catB ? (isMobile ? 56 : 72) : (isMobile ? 24 : 32),
                t: isMobile ? 28 : 40,
                b: isMobile ? 100 : 110
            },
            yaxis: {
                ...base.yaxis,
                title: catA.yTitle,
                titlefont: { color: catA.color, size: 12 },
                tickfont: { color: catA.color }
            }
        };

        if (catB) {
            layout.yaxis2 = {
                title: catB.yTitle,
                titlefont: { color: catB.color, size: 12 },
                tickfont: { color: catB.color },
                overlaying: 'y',
                side: 'right',
                showgrid: false,
                zerolinecolor: '#d8d4c7',
                linecolor: '#c8cfc5'
            };
        }

        return layout;
    }

    function getOverlayConfig(filenameBase = 'bpw-studio') {
        return getMemoryConfig(filenameBase);
    }

    function parseCsvText(text) {
        const lines = text.trim().split('\n');
        if (lines.length < 2) return [];
        const headers = lines[0].split(',').map(h => h.trim());
        const headerIndex = {};
        headers.forEach((header, index) => {
            headerIndex[header] = index;
        });

        const parsed = lines.slice(1).map(line => {
            const values = line.split(',');
            const get = (key) => {
                const index = headerIndex[key];
                return index === undefined ? '' : values[index];
            };
            const timestamp = Number(get('timestamp'));
            const elapsed = Number(get('elapsed_time'));
            const gcRaw = get('gc_time_s');
            const gcValue = gcRaw !== '' ? Number(gcRaw) : null;
            return {
                Timestamp: Number.isNaN(timestamp) ? 0 : timestamp,
                ElapsedTime: Number.isNaN(elapsed) ? 0 : elapsed,
                PID: get('pid'),
                Name: get('name'),
                RSS: Number(get('rss_mb')) || 0,
                HeapUsed: Number(get('heap_used_mb')) || 0,
                HeapCap: Number(get('heap_capacity_mb')) || 0,
                GCTime: gcValue !== null && !Number.isNaN(gcValue) ? gcValue * 1000 : null,
                GCTimeSeconds: gcValue !== null && !Number.isNaN(gcValue) ? gcValue : null,
                JITCompiledMethods: get('jit_compiled_methods') === '' ? null : Number(get('jit_compiled_methods')),
                JITFailedCompilations: get('jit_failed_compilations') === '' ? null : Number(get('jit_failed_compilations')),
                JITInvalidatedCompilations: get('jit_invalidated_compilations') === '' ? null : Number(get('jit_invalidated_compilations')),
                JITCompilationTimeMs: get('jit_compilation_time_ms') === '' ? null : Number(get('jit_compilation_time_ms')),
                ClassesLoaded: get('classes_loaded') === '' ? null : Number(get('classes_loaded')),
                ClassesUnloaded: get('classes_unloaded') === '' ? null : Number(get('classes_unloaded')),
                ClassLoadTimeMs: get('class_load_time_ms') === '' ? null : Number(get('class_load_time_ms'))
            };
        });
        return parsed;
    }

    function expandSamples(raw) {
        const samples = Array.isArray(raw?.samples) ? raw.samples : [];
        if (!samples.length || !Array.isArray(samples[0])) return samples;
        const fields = Array.isArray(raw?.sample_fields) ? raw.sample_fields : [];
        if (!fields.length) return [];
        return samples.map(row => Object.fromEntries(fields.map((field, index) => [field, row[index]])));
    }

    function compactSamples(samples) {
        const fields = [];
        const seen = new Set();
        samples.forEach(sample => {
            Object.keys(sample || {}).forEach(field => {
                if (!seen.has(field)) {
                    seen.add(field);
                    fields.push(field);
                }
            });
        });
        return {
            sample_fields: fields,
            samples: samples.map(sample => fields.map(field => sample[field] ?? null))
        };
    }

    function normalizeReportData(raw) {
        return {
            ...(raw || {}),
            samples: expandSamples(raw)
        };
    }

    function compactReportData(raw) {
        const compact = compactSamples(Array.isArray(raw?.samples) ? raw.samples : []);
        return {
            ...(raw || {}),
            ...compact
        };
    }

    function parseJsonText(text) {
        const raw = JSON.parse(text);
        const samples = expandSamples(raw);
        const processInfo = raw?.process_info && typeof raw.process_info === 'object' ? raw.process_info : {};
        const processSummary = raw?.process_summary || buildProcessSummary(samples, processInfo);
        return {
            samples,
            processInfo,
            processSummary,
            raw
        };
    }

    function normalizeCompareSamples(samples, baseTimestamp) {
        if (!samples.length || !baseTimestamp) return [];
        return samples.map(sample => {
            const elapsedMs = (sample.ElapsedTime || 0) * 1000;
            const timestamp = baseTimestamp + elapsedMs;
            return {
                ...sample,
                Timestamp: timestamp
            };
        });
    }

    function getGcLayout() {
        const isMobile = window.innerWidth < 768;
        return {
            title: isMobile ? '' : 'Garbage Collection Time Over Time',
            paper_bgcolor: '#ffffff',
            plot_bgcolor: '#fbfaf6',
            hovermode: 'x unified',
            xaxis: {
                title: 'Time',
                tickformat: isMobile ? '%H:%M' : '%H:%M:%S',
                tickangle: isMobile ? -45 : 0,
                gridcolor: '#e4e2d8',
                zerolinecolor: '#d8d4c7',
                linecolor: '#c8cfc5'
            },
            yaxis: {
                title: 'GC Time (s)',
                gridcolor: '#e4e2d8',
                zerolinecolor: '#d8d4c7',
                linecolor: '#c8cfc5'
            },
            showlegend: true,
            legend: {
                x: isMobile ? 0.5 : 1.02,
                y: isMobile ? -0.2 : 1,
                xanchor: isMobile ? 'center' : 'left',
                orientation: isMobile ? 'h' : 'v'
            },
            margin: {
                l: isMobile ? 50 : 60,
                r: isMobile ? 20 : 100,
                t: isMobile ? 20 : 40,
                b: isMobile ? 80 : 60
            },
            font: {
                size: isMobile ? 10 : 12,
                color: '#161a1d',
                family: '-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif'
            }
        };
    }

    function getGcConfig(filenameBase = 'build-monitor-gc') {
        const isMobile = window.innerWidth < 768;
        return {
            responsive: true,
            displayModeBar: true,
            displaylogo: false,
            modeBarButtonsToRemove: ['pan2d', 'lasso2d', 'select2d', 'autoScale2d'],
            toImageButtonOptions: {
                format: 'png',
                filename: filenameBase,
                height: isMobile ? 400 : 500,
                width: isMobile ? 800 : 1000,
                scale: 2
            }
        };
    }

    function getCounterLayout(title, yTitle) {
        const layout = getGcLayout();
        return { ...layout, title: window.innerWidth < 768 ? '' : title, yaxis: { ...layout.yaxis, title: yTitle } };
    }

    function getCounterConfig(filenameBase) {
        return getGcConfig(filenameBase);
    }

    function getRatioLayout() {
        const isMobile = window.innerWidth < 768;
        return {
            title: isMobile ? '' : 'Heap/RSS Ratio Over Time',
            paper_bgcolor: '#ffffff',
            plot_bgcolor: '#fbfaf6',
            hovermode: 'x unified',
            xaxis: {
                title: 'Time',
                tickformat: isMobile ? '%H:%M' : '%H:%M:%S',
                tickangle: isMobile ? -45 : 0,
                gridcolor: '#e4e2d8',
                zerolinecolor: '#d8d4c7',
                linecolor: '#c8cfc5'
            },
            yaxis: {
                title: 'Heap/RSS Ratio',
                gridcolor: '#e4e2d8',
                zerolinecolor: '#d8d4c7',
                linecolor: '#c8cfc5'
            },
            showlegend: true,
            legend: {
                x: isMobile ? 0.5 : 1.02,
                y: isMobile ? -0.2 : 1,
                xanchor: isMobile ? 'center' : 'left',
                orientation: isMobile ? 'h' : 'v'
            },
            margin: {
                l: isMobile ? 50 : 60,
                r: isMobile ? 20 : 100,
                t: isMobile ? 20 : 40,
                b: isMobile ? 80 : 60
            },
            font: {
                size: isMobile ? 10 : 12,
                color: '#161a1d',
                family: '-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif'
            }
        };
    }

    function getRatioConfig(filenameBase = 'build-monitor-rss-heap') {
        const isMobile = window.innerWidth < 768;
        return {
            responsive: true,
            displayModeBar: true,
            displaylogo: false,
            modeBarButtonsToRemove: ['pan2d', 'lasso2d', 'select2d', 'autoScale2d'],
            toImageButtonOptions: {
                format: 'png',
                filename: filenameBase,
                height: isMobile ? 400 : 500,
                width: isMobile ? 800 : 1000,
                scale: 2
            }
        };
    }

    function getMemoryLayout() {
        const isMobile = window.innerWidth < 768;
        return {
            title: isMobile ? '' : 'Memory Usage Over Time',
            paper_bgcolor: '#ffffff',
            plot_bgcolor: '#fbfaf6',
            hovermode: 'x unified',
            xaxis: {
                title: 'Time',
                tickformat: isMobile ? '%H:%M' : '%H:%M:%S',
                tickangle: isMobile ? -45 : 0,
                gridcolor: '#e4e2d8',
                zerolinecolor: '#d8d4c7',
                linecolor: '#c8cfc5'
            },
            yaxis: {
                title: 'Memory (MB)',
                gridcolor: '#e4e2d8',
                zerolinecolor: '#d8d4c7',
                linecolor: '#c8cfc5'
            },
            showlegend: true,
            legend: {
                x: isMobile ? 0.5 : 1.02,
                y: isMobile ? -0.2 : 1,
                xanchor: isMobile ? 'center' : 'left',
                orientation: isMobile ? 'h' : 'v'
            },
            margin: {
                l: isMobile ? 50 : 60,
                r: isMobile ? 20 : 100,
                t: isMobile ? 20 : 40,
                b: isMobile ? 80 : 60
            },
            font: {
                size: isMobile ? 10 : 12,
                color: '#161a1d',
                family: '-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif'
            }
        };
    }

    function getMemoryConfig(filenameBase = 'build-monitor') {
        const isMobile = window.innerWidth < 768;
        return {
            responsive: true,
            displayModeBar: true,
            displaylogo: false,
            modeBarButtonsToRemove: ['pan2d', 'lasso2d', 'select2d', 'autoScale2d'],
            toImageButtonOptions: {
                format: 'png',
                filename: filenameBase,
                height: isMobile ? 400 : 500,
                width: isMobile ? 800 : 1000,
                scale: 2
            }
        };
    }

    function formatValue(value, digits = 1) {
        if (value === null || value === undefined || Number.isNaN(value)) return 'N/A';
        if (typeof value !== 'number') return String(value);
        return value.toFixed(digits);
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (char) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        }[char]));
    }

    function formatDelta(value, digits = 1) {
        if (value === null || value === undefined || Number.isNaN(value)) return 'N/A';
        const sign = value > 0 ? '+' : '';
        return `${sign}${value.toFixed(digits)}`;
    }

    function getProcessType(name) {
        if (!name) return 'Other';
        if (name.includes('GradleDaemon')) return 'Gradle Daemon';
        if (name.includes('KotlinCompileDaemon')) return 'Kotlin Daemon';
        if (name.includes('GradleWorkerMain')) return 'Gradle Worker';
        return 'Other';
    }

    const GC_COLLECTOR_FLAGS = [
        { flag: 'UseG1GC', label: 'G1' },
        { flag: 'UseZGC', label: 'ZGC' },
        { flag: 'UseShenandoahGC', label: 'Shenandoah' },
        { flag: 'UseParallelGC', label: 'Parallel' },
        { flag: 'UseSerialGC', label: 'Serial' },
        { flag: 'UseConcMarkSweepGC', label: 'CMS' },
        { flag: 'UseEpsilonGC', label: 'Epsilon' }
    ];

    const GC_FLAG_PATTERN = /(?:^-(?:Xlog:gc|verbose:gc)|(?:GC|G1|ZGC|ZCollection|Shenandoah|MaxGCPauseMillis|InitiatingHeapOccupancyPercent|ConcGCThreads|ParallelGCThreads|SurvivorRatio|TenuringThreshold|ExplicitGC))/i;

    function normalizeFlags(vmFlags) {
        if (!Array.isArray(vmFlags)) return [];
        return [...new Set(vmFlags.filter(Boolean).map(flag => String(flag)))].sort((a, b) => a.localeCompare(b));
    }

    function getGcType(vmFlags) {
        const flags = normalizeFlags(vmFlags);
        const disabledCollectors = new Set(flags
            .map(flag => flag.match(/^-XX:-([A-Za-z0-9]+GC)$/)?.[1])
            .filter(Boolean));
        const enabled = GC_COLLECTOR_FLAGS
            .filter(({ flag }) => !disabledCollectors.has(flag) && flags.some(entry => entry.includes(`+${flag}`)))
            .map(({ label }) => label);
        return enabled.length ? enabled.join(' + ') : 'Default';
    }

    function getGcFlags(vmFlags) {
        return normalizeFlags(vmFlags).filter(flag => GC_FLAG_PATTERN.test(flag));
    }

    function diffFlags(baseFlags, compareFlags) {
        const baseSet = new Set(baseFlags);
        const compareSet = new Set(compareFlags);
        return {
            added: compareFlags.filter(flag => !baseSet.has(flag)),
            removed: baseFlags.filter(flag => !compareSet.has(flag)),
            shared: compareFlags.filter(flag => baseSet.has(flag))
        };
    }

    function buildCompareSummaryHtml({ baseLabel, compareLabel, baseProcessSummary, compareProcessSummary }) {
        const baseSummary = baseProcessSummary;
        const compareSummary = compareProcessSummary;
        if (!baseSummary || !compareSummary) return '';

        const baseByName = baseSummary.byName || {};
        const compareByName = compareSummary.byName || {};
        const names = [...new Set([...Object.keys(baseByName), ...Object.keys(compareByName)])]
            .sort((a, b) => getProcessType(a).localeCompare(getProcessType(b)) || a.localeCompare(b));
        if (!names.length) return '';

        const safeBaseLabel = escapeHtml(baseLabel);
        const safeCompareLabel = escapeHtml(compareLabel);
        const readMetric = (entry, key) => {
            if (!entry) return null;
            if (key === 'jitTimeSeconds') {
                return entry.finalJITTimeMs === null || entry.finalJITTimeMs === undefined ? null : entry.finalJITTimeMs / 1000;
            }
            return entry[key] === undefined ? null : entry[key];
        };
        const formatMetric = (value, decimals, suffix) => {
            if (value === null || value === undefined || Number.isNaN(Number(value))) return 'N/A';
            return `${formatValue(value, decimals)}${suffix || ''}`;
        };
        const deltaClass = (delta) => {
            if (!Number.isFinite(delta) || delta === 0) return 'neutral';
            return delta > 0 ? 'up' : 'down';
        };
        const renderMetric = (label, key, decimals, suffix, baseEntry, compareEntry) => {
            const baseValue = readMetric(baseEntry, key);
            const compareValue = readMetric(compareEntry, key);
            const delta = baseValue !== null && compareValue !== null ? compareValue - baseValue : null;
            return `
                <div class="compare-process-metric">
                    <span>${label}</span>
                    <strong>${formatMetric(baseValue, decimals, suffix)}</strong>
                    <strong>${formatMetric(compareValue, decimals, suffix)}</strong>
                    <em class="${deltaClass(delta)}">${delta === null ? 'N/A' : `${delta > 0 ? '+' : ''}${formatValue(delta, decimals)}${suffix || ''}`}</em>
                </div>
            `;
        };
        const renderTextMetric = (label, baseValue, compareValue) => {
            const safeBaseValue = escapeHtml(baseValue);
            const safeCompareValue = escapeHtml(compareValue);
            const changed = baseValue !== compareValue;
            return `
                <div class="compare-process-metric">
                    <span>${label}</span>
                    <strong>${safeBaseValue}</strong>
                    <strong>${safeCompareValue}</strong>
                    <em class="${changed ? 'changed' : 'neutral'}">${changed ? 'Changed' : 'Same'}</em>
                </div>
            `;
        };
        const renderFlags = (entry, label) => {
            const flags = entry?.vmFlags || [];
            if (!flags.length) return `<span class="meta">${label}: no VM flags</span>`;
            return `
                <details class="compare-process-flags">
                    <summary>${label}: VM flags (${flags.length})</summary>
                    <div class="vm-flags-list">${flags.map(flag => `<span class="vm-flag">${escapeHtml(flag)}</span>`).join('')}</div>
                </details>
            `;
        };
        const renderGcFlagDiff = (baseEntry, compareEntry) => {
            const diff = diffFlags(getGcFlags(baseEntry?.vmFlags), getGcFlags(compareEntry?.vmFlags));
            const renderGroup = (label, flags, className) => {
                if (!flags.length) return '';
                return `
                    <div class="compare-process-flag-group ${className}">
                        <span>${label}</span>
                        <div class="vm-flags-list">${flags.map(flag => `<span class="vm-flag">${escapeHtml(flag)}</span>`).join('')}</div>
                    </div>
                `;
            };
            if (!diff.added.length && !diff.removed.length) {
                const sharedText = diff.shared.length
                    ? `${diff.shared.length} shared GC flag${diff.shared.length === 1 ? '' : 's'}`
                    : 'No explicit GC flags in either run';
                return `
                    <div class="compare-process-flag-diff">
                        <strong>GC flag differences</strong>
                        <span class="meta">${sharedText}; no changes detected.</span>
                    </div>
                `;
            }
            return `
                <div class="compare-process-flag-diff">
                    <strong>GC flag differences</strong>
                    ${renderGroup(`Added in ${safeCompareLabel}`, diff.added, 'added')}
                    ${renderGroup(`Removed from ${safeBaseLabel}`, diff.removed, 'removed')}
                </div>
            `;
        };

        const cards = names.map((name) => {
            const baseEntry = baseByName[name] || null;
            const compareEntry = compareByName[name] || null;
            const safeName = escapeHtml(name);
            const safeType = escapeHtml(getProcessType(name));
            const basePids = baseEntry?.pids?.length ? baseEntry.pids.map(escapeHtml).join(', ') : 'missing';
            const comparePids = compareEntry?.pids?.length ? compareEntry.pids.map(escapeHtml).join(', ') : 'missing';
            const baseGcType = baseEntry ? getGcType(baseEntry.vmFlags) : 'N/A';
            const compareGcType = compareEntry ? getGcType(compareEntry.vmFlags) : 'N/A';
            return `
                <article class="compare-process-card">
                    <div class="compare-process-title">
                        <div>
                            <span>${safeType}</span>
                            <h4>${safeName}</h4>
                        </div>
                        <div class="compare-process-pids">
                            <span>${safeBaseLabel}: ${basePids}</span>
                            <span>${safeCompareLabel}: ${comparePids}</span>
                        </div>
                    </div>
                    <div class="compare-process-grid">
                        <div class="compare-process-grid-head"><span>Metric</span><strong>${safeBaseLabel}</strong><strong>${safeCompareLabel}</strong><em>Delta</em></div>
                        ${renderMetric('Max RSS', 'maxRss', 1, ' MB', baseEntry, compareEntry)}
                        ${renderMetric('Max Heap', 'maxHeap', 1, ' MB', baseEntry, compareEntry)}
                        ${renderTextMetric('GC type', baseGcType, compareGcType)}
                        ${renderMetric('GC time', 'totalGCTime', 3, ' s', baseEntry, compareEntry)}
                        ${renderMetric('Duration', 'durationSeconds', 1, ' s', baseEntry, compareEntry)}
                        ${renderMetric('Compiled', 'finalCompiledMethods', 0, '', baseEntry, compareEntry)}
                        ${renderMetric('JIT time', 'jitTimeSeconds', 3, ' s', baseEntry, compareEntry)}
                        ${renderMetric('Classes', 'finalClassesLoaded', 0, '', baseEntry, compareEntry)}
                    </div>
                    <div class="compare-process-details">
                        ${renderGcFlagDiff(baseEntry, compareEntry)}
                        ${renderFlags(baseEntry, safeBaseLabel)}
                        ${renderFlags(compareEntry, safeCompareLabel)}
                    </div>
                </article>
            `;
        }).join('');

        const peakDelta = (compareSummary.overallMaxRss || 0) - (baseSummary.overallMaxRss || 0);
        return `
            <div class="compare-process-summary">
                <div class="compare-process-summary-head">
                    <div>
                        <h3>Process Comparison</h3>
                        <p>Grouped by process name, with ${safeCompareLabel} deltas against ${safeBaseLabel}.</p>
                    </div>
                    <div class="compare-process-total"><span>Peak RSS delta</span><strong>${peakDelta > 0 ? '+' : ''}${formatValue(peakDelta, 1)} MB</strong></div>
                </div>
                <div class="compare-process-list">${cards}</div>
            </div>
        `;
    }

    function renderCompareSection(options) {
        const {
            baseSamples = [],
            compareSamplesRaw = [],
            compareSectionId = 'compare-section',
            compareModeStorageKey = 'compareMode',
            baseLabel = 'Current Run',
            compareLabel = 'Comparison Run',
            headerTitle = 'Comparison',
            headerSubtitle = 'Replay both runs with a shared timeline',
            memoryFilenameBase,
            gcFilenameBase,
            ratioFilenameBase,
            baseProcessSummary,
            compareProcessSummary
        } = options || {};

        const compareSection = typeof compareSectionId === 'string'
            ? document.getElementById(compareSectionId)
            : compareSectionId;
        if (!compareSection) return;
        if (!Array.isArray(compareSamplesRaw) || !compareSamplesRaw.length) {
            compareSection.style.display = 'none';
            compareSection.innerHTML = '';
            return;
        }

        const timestamps = [...new Set(baseSamples.map(s => s.Timestamp))].sort((a, b) => a - b);
        const compareSamples = normalizeCompareSamples(compareSamplesRaw, timestamps[0]);
        const baseHasGC = hasGCData(baseSamples);
        const compareHasGC = hasGCData(compareSamples);
        const showGC = baseHasGC && compareHasGC;
        const showJIT = hasJITData(baseSamples) || hasJITData(compareSamples);
        const showClasses = hasClassLoadingData(baseSamples) || hasClassLoadingData(compareSamples);

        const storedMode = localStorage.getItem(compareModeStorageKey) || 'split';
        const compareMode = storedMode === 'side' ? 'side' : 'split';
        const isSplitMode = compareMode === 'split';
        const splitLabel = `${baseLabel} vs ${compareLabel} (Split View)`;
        const counterPanel = (metrics) => isSplitMode
            ? metrics.map(([id, metricTitle]) => `<div class="chart-container"><h4>${metricTitle}</h4><div class="chart-wrapper"><div id="compare-${id}" style="width:100%;height:400px"></div></div></div>`).join('')
            : metrics.map(([id, metricTitle]) => `<div class="compare-grid">${[baseLabel, compareLabel].map((label, index) => `<div class="chart-container"><h4>${metricTitle}: ${label}</h4><div class="chart-wrapper"><div id="compare-${index === 0 ? 'current' : 'other'}-${id}" style="width:100%;height:400px"></div></div></div>`).join('')}</div>`).join('');

        compareSection.innerHTML = `
            <div class="compare-header">
                <h2>${headerTitle}</h2>
                <span class="meta">${headerSubtitle}</span>
                <label class="meta" style="display:flex; align-items:center; gap:0.5rem;">
                    View:
                    <select id="compare-view-mode">
                        <option value="split" ${isSplitMode ? 'selected' : ''}>Split View</option>
                        <option value="side" ${!isSplitMode ? 'selected' : ''}>Side by Side</option>
                    </select>
                </label>
            </div>
            <div class="replay-controls" id="compare-replay-controls">
                <div class="buttons">
                    <button class="btn" id="btn-compare-replay-play">Play</button>
                    <button class="btn secondary" id="btn-compare-replay-pause">Pause</button>
                    <button class="btn secondary" id="btn-compare-replay-reset">Reset</button>
                </div>
                <div class="meta" id="compare-replay-meta">Frame 0 / 0</div>
                <div class="timeline">
                    <input type="range" id="compare-replay-timeline" aria-label="Replay position" min="0" max="0" value="0">
                    <div class="meta" id="compare-replay-time-label">Elapsed: 0s</div>
                    <div class="meta">
                        Speed:
                        <select id="compare-replay-speed" aria-label="Playback speed">
                            <option value="5">5x</option>
                            <option value="10">10x</option>
                            <option value="15" selected>15x</option>
                            <option value="20">20x</option>
                            <option value="25">25x</option>
                            <option value="30">30x</option>
                            <option value="35">35x</option>
                            <option value="40">40x</option>
                            <option value="45">45x</option>
                            <option value="50">50x</option>
                        </select>
                    </div>
                </div>
            </div>
            <div class="compare-grid">
                ${isSplitMode ? `
                <div class="compare-column">
                    <h3>${splitLabel}</h3>
                    <div class="chart-filters" id="compare-split-filters">
                        <label><input type="checkbox" id="filter-compare-total-rss" checked> Total RSS</label>
                        <label><input type="checkbox" id="filter-compare-rss" checked> RSS</label>
                        <label><input type="checkbox" id="filter-compare-heap" checked> Heap</label>
                    </div>
                    <div class="chart-container">
                        <h4>Memory Usage Over Time</h4>
                        <div class="chart-wrapper">
                            <div id="compare-rss" style="width: 100%; height: 460px;"></div>
                        </div>
                    </div>
                    ${showGC ? `
                    <div class="chart-container">
                        <h4>Garbage Collection Time Over Time</h4>
                        <div class="chart-wrapper">
                            <div id="compare-gc" style="width: 100%; height: 460px;"></div>
                        </div>
                    </div>
                    ` : ''}
                    
                </div>
                ` : `
                <div class="compare-column">
                    <h3>${baseLabel}</h3>
                    <div class="chart-filters" id="compare-current-filters">
                        <label><input type="checkbox" id="filter-current-total-rss" checked> Total RSS</label>
                        <label><input type="checkbox" id="filter-current-rss" checked> RSS</label>
                        <label><input type="checkbox" id="filter-current-heap" checked> Heap</label>
                    </div>
                    <div class="chart-container">
                        <h4>Memory Usage Over Time</h4>
                        <div class="chart-wrapper">
                            <div id="compare-current-rss" style="width: 100%; height: 460px;"></div>
                        </div>
                    </div>
                    ${showGC ? `
                    <div class="chart-container">
                        <h4>Garbage Collection Time Over Time</h4>
                        <div class="chart-wrapper">
                            <div id="compare-current-gc" style="width: 100%; height: 460px;"></div>
                        </div>
                    </div>
                    ` : ''}
                    
                </div>
                <div class="compare-column">
                    <h3>${compareLabel}</h3>
                    <div class="chart-filters" id="compare-other-filters">
                        <label><input type="checkbox" id="filter-other-total-rss" checked> Total RSS</label>
                        <label><input type="checkbox" id="filter-other-rss" checked> RSS</label>
                        <label><input type="checkbox" id="filter-other-heap" checked> Heap</label>
                    </div>
                    <div class="chart-container">
                        <h4>Memory Usage Over Time</h4>
                        <div class="chart-wrapper">
                            <div id="compare-other-rss" style="width: 100%; height: 460px;"></div>
                        </div>
                    </div>
                    ${showGC ? `
                    <div class="chart-container">
                        <h4>Garbage Collection Time Over Time</h4>
                        <div class="chart-wrapper">
                            <div id="compare-other-gc" style="width: 100%; height: 460px;"></div>
                        </div>
                    </div>
                    ` : ''}
                    
                </div>
                `}
            </div>
            ${showJIT ? counterPanel([
                ['jit-time', 'Cumulative JIT Compilation Time'],
                ['jit-rate', 'JIT Compilation Activity']
            ]) : ''}
            ${showClasses ? counterPanel([
                ['classes-loaded', 'Cumulative Classes Loaded'],
                ['class-rate', 'Class Loading Activity']
            ]) : ''}
        `;

        compareSection.style.display = 'block';

        const baseData = buildReplayData(baseSamples, timestamps, COLOR_PALETTE);
        const chartTimestamps = baseData.timestamps || timestamps;
        const compareData = buildReplayData(compareSamples, chartTimestamps, COLOR_PALETTE);

        const elapsedSeconds = chartTimestamps.map(ts => Math.max(0, (ts - chartTimestamps[0]) / 1000));
        const maxElapsed = elapsedSeconds.length ? elapsedSeconds[elapsedSeconds.length - 1] : 0;
        const compareElapsed = isSplitMode
            ? elapsedSeconds.map(value => value + maxElapsed)
            : elapsedSeconds;
        const tickVals = [];
        const tickText = [];
        if (isSplitMode && maxElapsed > 0) {
            const tickStep = Math.max(1, Math.round(maxElapsed / 5));
            for (let value = 0; value <= maxElapsed; value += tickStep) {
                tickVals.push(value, value + maxElapsed);
                tickText.push(String(value), String(value));
            }
        }

        const sharedProcessNames = [...new Set([
            ...baseSamples.map(s => s.Name),
            ...compareSamples.map(s => s.Name)
        ])];
        const sharedColorMap = buildColorMap(sharedProcessNames, COLOR_PALETTE);
        [baseData, compareData].forEach(data => {
            data.processKeys.forEach(processKey => {
                const def = data.series[processKey];
                def.color = sharedColorMap[def.processName] || def.color;
            });
        });

        const baseStyle = {
            lineWidth: 3,
            heapLineWidth: 2,
            markerSize: 6,
            lineDash: 'solid',
            heapDash: 'dash',
            lineOpacity: 1,
            markerOpacity: 1,
            includeTotalRss: true,
            totalLabel: 'Total RSS Memory',
            totalColor: '#2c3e50'
        };
        const compareStyle = {
            lineWidth: 4,
            heapLineWidth: 3,
            markerSize: 8,
            lineDash: 'solid',
            heapDash: 'dash',
            lineOpacity: 0.6,
            markerOpacity: 0.6,
            includeTotalRss: true,
            totalLabel: 'Compare Total RSS Memory',
            totalColor: '#0f172a'
        };

        const timeline = document.getElementById('compare-replay-timeline');
        const meta = document.getElementById('compare-replay-meta');
        const timeLabel = document.getElementById('compare-replay-time-label');
        const playBtn = document.getElementById('btn-compare-replay-play');
        const pauseBtn = document.getElementById('btn-compare-replay-pause');
        const resetBtn = document.getElementById('btn-compare-replay-reset');
        const speedSelect = document.getElementById('compare-replay-speed');

        let isPlaying = false;
        let playTimer = null;
        let currentFrame = 0;
        let speedMultiplier = Number(speedSelect.value) || 15;

        timeline.max = String(Math.max(0, chartTimestamps.length - 1));

        const elapsedByTimestamp = new Map();
        baseSamples.forEach(sample => {
            if (!elapsedByTimestamp.has(sample.Timestamp)) {
                elapsedByTimestamp.set(sample.Timestamp, sample.ElapsedTime);
            }
        });

        function setupCompareChartFilters(chartId, totalId, rssId, heapId, isTotalTrace) {
            const total = document.getElementById(totalId);
            const rss = document.getElementById(rssId);
            const heap = document.getElementById(heapId);
            if (!total || !rss || !heap) return;
            const applyFilters = () => {
                const chart = document.getElementById(chartId);
                if (!chart || !chart.data) return;
                const map = visibilityStore[chartId] || (visibilityStore[chartId] = {});
                chart.data.forEach(trace => {
                    if (!trace.name) return;
                    if (isTotalTrace(trace.name)) {
                        map[trace.name] = total.checked ? true : 'legendonly';
                    } else if (trace.name.includes('(RSS)')) {
                        map[trace.name] = rss.checked ? true : 'legendonly';
                    } else if (trace.name.includes('(Heap)')) {
                        map[trace.name] = heap.checked ? true : 'legendonly';
                    }
                });
                const visArray = chart.data.map(trace => map[trace.name] !== undefined ? map[trace.name] : true);
                Plotly.restyle(chart, 'visible', visArray);
            };
            total.addEventListener('change', applyFilters);
            rss.addEventListener('change', applyFilters);
            heap.addEventListener('change', applyFilters);
            applyFilters();
        }

        function updateCompareChartFilterCheckboxes(chartId, totalId, rssId, heapId, isTotalTrace) {
            const total = document.getElementById(totalId);
            const rss = document.getElementById(rssId);
            const heap = document.getElementById(heapId);
            const chart = document.getElementById(chartId);
            if (!total || !rss || !heap || !chart || !chart.data) return;
            const map = visibilityStore[chartId] || {};
            let rssVisible = false;
            let heapVisible = false;
            let totalVisible = true;
            chart.data.forEach(trace => {
                if (!trace.name) return;
                const vis = map[trace.name];
                const isVisible = vis !== 'legendonly' && vis !== false;
                if (isTotalTrace(trace.name)) {
                    totalVisible = totalVisible && isVisible;
                } else if (trace.name.includes('(RSS)')) {
                    rssVisible = rssVisible || isVisible;
                } else if (trace.name.includes('(Heap)')) {
                    heapVisible = heapVisible || isVisible;
                }
            });
            total.checked = totalVisible;
            rss.checked = rssVisible;
            heap.checked = heapVisible;
        }

        function updateUi(frameIndex) {
            timeline.value = String(frameIndex);
            meta.textContent = `Frame ${frameIndex + 1} / ${chartTimestamps.length}`;
            const timestamp = chartTimestamps[frameIndex];
            const elapsed = elapsedByTimestamp.get(timestamp) || 0;
            timeLabel.textContent = `Elapsed: ${elapsed}s`;
        }

        function renderFrame(frameIndex) {
            currentFrame = frameIndex;
            updateUi(frameIndex);
            const tasks = [];
            const compareLayout = {
                ...getMemoryLayout(),
                xaxis: {
                    ...getMemoryLayout().xaxis,
                    title: 'Elapsed (s)',
                    tickformat: null,
                    type: 'linear',
                    tickvals: isSplitMode ? tickVals : undefined,
                    ticktext: isSplitMode ? tickText : undefined
                },
                legend: {
                    x: 0.5,
                    y: -0.25,
                    xanchor: 'center',
                    orientation: 'h'
                },
                margin: {
                    ...getMemoryLayout().margin,
                    b: 110
                },
                shapes: [
                    {
                        type: 'line',
                        x0: maxElapsed,
                        x1: maxElapsed,
                        y0: 0,
                        y1: 1,
                        xref: 'x',
                        yref: 'paper',
                        line: { color: '#94a3b8', width: 1, dash: 'dot' }
                    }
                ]
            };
            if (isSplitMode) {
                const rssTraces = [
                    ...buildMetricTraces(baseData, timestamps, frameIndex, 'rss', baseStyle, elapsedSeconds),
                    ...buildMetricTraces(compareData, timestamps, frameIndex, 'rss', compareStyle, compareElapsed)
                ];
                tasks.push(Plotly.react('compare-rss', applyVisibilityToTraces('compare-rss', rssTraces), compareLayout, getMemoryConfig(memoryFilenameBase)));
            } else {
                const sideLayout = {
                    ...compareLayout,
                    shapes: []
                };
                tasks.push(Plotly.react('compare-current-rss', applyVisibilityToTraces('compare-current-rss', buildMetricTraces(baseData, timestamps, frameIndex, 'rss', baseStyle, elapsedSeconds)), sideLayout, getMemoryConfig(memoryFilenameBase)));
                tasks.push(Plotly.react('compare-other-rss', applyVisibilityToTraces('compare-other-rss', buildMetricTraces(compareData, timestamps, frameIndex, 'rss', compareStyle, elapsedSeconds)), sideLayout, getMemoryConfig(memoryFilenameBase)));
            }
            if (showGC) {
                const compareGcLayout = {
                    ...getGcLayout(),
                    xaxis: {
                        ...getGcLayout().xaxis,
                        title: 'Elapsed (s)',
                        tickformat: null,
                        type: 'linear',
                        tickvals: isSplitMode ? tickVals : undefined,
                        ticktext: isSplitMode ? tickText : undefined
                    },
                    legend: {
                        x: 0.5,
                        y: -0.25,
                        xanchor: 'center',
                        orientation: 'h'
                    },
                    margin: {
                        ...getGcLayout().margin,
                        b: 110
                    },
                    shapes: [
                        {
                            type: 'line',
                            x0: maxElapsed,
                            x1: maxElapsed,
                            y0: 0,
                            y1: 1,
                            xref: 'x',
                            yref: 'paper',
                            line: { color: '#94a3b8', width: 1, dash: 'dot' }
                        }
                    ]
                };
                if (isSplitMode) {
                    const gcTraces = [
                        ...buildMetricTraces(baseData, timestamps, frameIndex, 'gc', baseStyle, elapsedSeconds),
                        ...buildMetricTraces(compareData, timestamps, frameIndex, 'gc', compareStyle, compareElapsed)
                    ];
                    tasks.push(Plotly.react('compare-gc', applyVisibilityToTraces('compare-gc', gcTraces), compareGcLayout, getGcConfig(gcFilenameBase)));
                } else {
                    const sideGcLayout = {
                        ...compareGcLayout,
                        shapes: []
                    };
                    tasks.push(Plotly.react('compare-current-gc', applyVisibilityToTraces('compare-current-gc', buildMetricTraces(baseData, timestamps, frameIndex, 'gc', baseStyle, elapsedSeconds)), sideGcLayout, getGcConfig(gcFilenameBase)));
                    tasks.push(Plotly.react('compare-other-gc', applyVisibilityToTraces('compare-other-gc', buildMetricTraces(compareData, timestamps, frameIndex, 'gc', compareStyle, compareElapsed)), sideGcLayout, getGcConfig(gcFilenameBase)));
                }
            }
            const renderCounterMetric = (id, metric, title, yTitle) => {
                const layout = getCounterLayout(title, yTitle);
                layout.xaxis = {
                    ...layout.xaxis,
                    title: 'Elapsed (s)',
                    tickformat: null,
                    type: 'linear',
                    tickvals: isSplitMode ? tickVals : undefined,
                    ticktext: isSplitMode ? tickText : undefined
                };
                layout.legend = {
                    x: 0.5,
                    y: -0.25,
                    xanchor: 'center',
                    orientation: 'h'
                };
                layout.margin = {
                    ...layout.margin,
                    b: 110
                };
                layout.shapes = isSplitMode ? [
                    {
                        type: 'line',
                        x0: maxElapsed,
                        x1: maxElapsed,
                        y0: 0,
                        y1: 1,
                        xref: 'x',
                        yref: 'paper',
                        line: { color: '#94a3b8', width: 1, dash: 'dot' }
                    }
                ] : [];
                const labelTraces = (traces, label) => traces.map(trace => ({
                    ...trace,
                    name: `${label}: ${trace.name}`
                }));
                if (isSplitMode) {
                    const traces = [
                        ...labelTraces(buildMetricTraces(baseData, timestamps, frameIndex, metric, baseStyle, elapsedSeconds), baseLabel),
                        ...labelTraces(buildMetricTraces(compareData, timestamps, frameIndex, metric, compareStyle, compareElapsed), compareLabel)
                    ];
                    tasks.push(Plotly.react(`compare-${id}`, applyVisibilityToTraces(`compare-${id}`, traces), layout, getCounterConfig(`compare-${metric}`)));
                } else {
                    tasks.push(Plotly.react(`compare-current-${id}`, applyVisibilityToTraces(`compare-current-${id}`, buildMetricTraces(baseData, timestamps, frameIndex, metric, baseStyle, elapsedSeconds)), layout, getCounterConfig(`compare-current-${metric}`)));
                    tasks.push(Plotly.react(`compare-other-${id}`, applyVisibilityToTraces(`compare-other-${id}`, buildMetricTraces(compareData, timestamps, frameIndex, metric, compareStyle, elapsedSeconds)), layout, getCounterConfig(`compare-other-${metric}`)));
                }
            };
            if (showJIT) {
                renderCounterMetric('jit-time', 'jitTime', 'Cumulative JIT Compilation Time', 'Compilation Time (s)');
                renderCounterMetric('jit-rate', 'jitRate', 'JIT Compilation Activity', 'Compiled Methods / s');
            }
            if (showClasses) {
                renderCounterMetric('classes-loaded', 'classesLoaded', 'Cumulative Classes Loaded', 'Classes Loaded');
                renderCounterMetric('class-rate', 'classRate', 'Class Loading Activity', 'Classes / s');
            }
            return Promise.all(tasks).then(() => {
                const isTotalSplit = (name) => name === 'Total RSS Memory' || name === 'Compare Total RSS Memory';
                const isTotalBase = (name) => name === 'Total RSS Memory';
                const isTotalCompare = (name) => name === 'Compare Total RSS Memory';
                if (isSplitMode) {
                    setupCompareChartFilters('compare-rss', 'filter-compare-total-rss', 'filter-compare-rss', 'filter-compare-heap', isTotalSplit);
                    attachLegendVisibilityHandlers('compare-rss', () => updateCompareChartFilterCheckboxes('compare-rss', 'filter-compare-total-rss', 'filter-compare-rss', 'filter-compare-heap', isTotalSplit));
                    if (showGC) {
                        attachLegendVisibilityHandlers('compare-gc');
                    }
                } else {
                    setupCompareChartFilters('compare-current-rss', 'filter-current-total-rss', 'filter-current-rss', 'filter-current-heap', isTotalBase);
                    setupCompareChartFilters('compare-other-rss', 'filter-other-total-rss', 'filter-other-rss', 'filter-other-heap', isTotalCompare);
                    attachLegendVisibilityHandlers('compare-current-rss', () => updateCompareChartFilterCheckboxes('compare-current-rss', 'filter-current-total-rss', 'filter-current-rss', 'filter-current-heap', isTotalBase));
                    attachLegendVisibilityHandlers('compare-other-rss', () => updateCompareChartFilterCheckboxes('compare-other-rss', 'filter-other-total-rss', 'filter-other-rss', 'filter-other-heap', isTotalCompare));
                    if (showGC) {
                        attachLegendVisibilityHandlers('compare-current-gc');
                        attachLegendVisibilityHandlers('compare-other-gc');
                    }
                }
                const counterIds = ['jit-time', 'jit-rate', 'classes-loaded', 'class-rate'];
                counterIds.forEach(id => {
                    if (isSplitMode) {
                        if (document.getElementById(`compare-${id}`)) attachLegendVisibilityHandlers(`compare-${id}`);
                    } else {
                        if (document.getElementById(`compare-current-${id}`)) attachLegendVisibilityHandlers(`compare-current-${id}`);
                        if (document.getElementById(`compare-other-${id}`)) attachLegendVisibilityHandlers(`compare-other-${id}`);
                    }
                });
            });
        }

        function pause() {
            if (playTimer) clearTimeout(playTimer);
            playTimer = null;
            isPlaying = false;
        }

        function play() {
            if (isPlaying) return;
            isPlaying = true;
            const tick = () => {
                if (!isPlaying) return;
                const nextFrame = Math.min(currentFrame + 1, chartTimestamps.length - 1);
                renderFrame(nextFrame);
                if (nextFrame >= chartTimestamps.length - 1) {
                    pause();
                    return;
                }
                playTimer = setTimeout(tick, 1000 / speedMultiplier);
            };
            playTimer = setTimeout(tick, 1000 / speedMultiplier);
        }

        function reset() {
            pause();
            renderFrame(0);
        }

        timeline.addEventListener('input', event => {
            pause();
            const value = Number(event.target.value) || 0;
            renderFrame(value);
        });

        playBtn.addEventListener('click', play);
        pauseBtn.addEventListener('click', pause);
        resetBtn.addEventListener('click', reset);
        speedSelect.addEventListener('change', event => {
            speedMultiplier = Number(event.target.value) || 15;
        });

        if (!global.compareReplayStops) {
            global.compareReplayStops = {};
        }
        global.compareReplayStops.default = pause;

        renderFrame(0).then(() => {
            const summaryHtml = buildCompareSummaryHtml({
                baseLabel,
                compareLabel,
                baseProcessSummary,
                compareProcessSummary
            });
            if (summaryHtml) {
                const summaryWrapper = document.createElement('div');
                summaryWrapper.innerHTML = summaryHtml;
                compareSection.appendChild(summaryWrapper);
            }
        });

        const viewSelect = document.getElementById('compare-view-mode');
        if (viewSelect) {
            viewSelect.addEventListener('change', (event) => {
                const nextMode = event.target.value === 'side' ? 'side' : 'split';
                localStorage.setItem(compareModeStorageKey, nextMode);
                renderCompareSection({
                    baseSamples,
                    compareSamplesRaw,
                    compareSectionId,
                    compareModeStorageKey,
                    baseLabel,
                    compareLabel,
                    headerTitle,
                    headerSubtitle,
                    memoryFilenameBase,
                    gcFilenameBase,
                    ratioFilenameBase,
                    baseProcessSummary,
                    compareProcessSummary
                });
            });
        }
    }

    global.BpwCompareShared = {
        COLOR_PALETTE,
        visibilityStore,
        applyVisibilityToTraces,
        attachLegendVisibilityHandlers,
        hasGCData,
        hasRatioData,
        hasJITData,
        hasClassLoadingData,
        buildColorMap,
        getMedianDelta,
        buildTotalRssSeries,
        buildForwardFilledSeries,
        buildExactSeries,
        buildCounterSeries,
        buildReplayData,
        buildMetricTraces,
        buildOverlayTraces,
        getAvailableOverlayMetrics,
        getOverlayLayout,
        getOverlayConfig,
        METRIC_CATALOG,
        OVERLAY_PRESETS,
        getGcType,
        getGcFlags,
        diffFlags,
        parseCsvText,
        parseJsonText,
        expandSamples,
        compactSamples,
        normalizeReportData,
        compactReportData,
        buildProcessSummary,
        normalizeCompareSamples,
        getGcLayout,
        getGcConfig,
        getCounterLayout,
        getCounterConfig,
        getRatioLayout,
        getRatioConfig,
        getMemoryLayout,
        getMemoryConfig,
        renderCompareSection
    };
})(window);
