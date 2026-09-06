import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as core from '@actions/core';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { parseTimestampSeconds, generateJsonReport } from './lib/report';
import { generateCombinedMermaidChart, MermaidProcessData } from './lib/mermaid';
import { artifactSummary, existingArtifactPaths } from './lib/artifacts';
import { parseMonitorLogText, parseOptionalMetric } from './lib/monitor_log';
import {
    ACTION_RUNTIME_STATE_FILE_NAMES,
    ACTION_RUNTIME_STATE_FILES,
    actionRuntimeStateFilePath,
    getActionRuntimeTempRoot,
    getActionRunTempDir,
    resolveActionRuntimeStateCandidateDirs,
    resolveRunIdBackupCandidateFiles,
} from './action_config';

const execAsync = promisify(exec);

type ProcessData = MermaidProcessData;

function parseLogFile(logFile: string): { processes: Map<string, ProcessData>, timestamps: string[], hasGcData: boolean, hasJitData: boolean, hasClassData: boolean } {
    const processes = new Map<string, ProcessData>();
    const timestamps = new Set<string>();
    let hasGcData = false;
    let hasJitData = false;
    let hasClassData = false;

    parseMonitorLogText(fs.readFileSync(logFile, 'utf8')).forEach(row => {
        const rssValue = parseFloat(row.rssMb);
        const heapUsedValue = parseFloat(row.heapUsedMb);
        const heapCapValue = parseFloat(row.heapCapMb);
        const processKey = `${row.pid}-${row.name}`;
        const [
            jitCompiled,
            jitFailed,
            ,
            ,
            classesLoaded,
            classesUnloaded
        ] = row.optionalMetricRaws;

        if (!processes.has(processKey)) {
            processes.set(processKey, {
                timestamps: [],
                rss: [],
                heapUsed: [],
                heapCap: [],
                gcTime: [],
                gcAvailable: [],
                jitCompiledMethods: [],
                jitFailedCompilations: [],
                classesLoaded: [],
                classesUnloaded: []
            });
        }

        const processData = processes.get(processKey)!;
        processData.timestamps.push(row.timestamp);
        processData.rss.push(rssValue);
        timestamps.add(row.timestamp);
        processData.heapUsed.push(heapUsedValue);
        processData.heapCap.push(heapCapValue);

        const jitCompiledValue = parseOptionalMetric(jitCompiled);
        const jitFailedValue = parseOptionalMetric(jitFailed);
        const classesLoadedValue = parseOptionalMetric(classesLoaded);
        const classesUnloadedValue = parseOptionalMetric(classesUnloaded);
        processData.jitCompiledMethods.push(jitCompiledValue);
        processData.jitFailedCompilations.push(jitFailedValue);
        processData.classesLoaded.push(classesLoadedValue);
        processData.classesUnloaded.push(classesUnloadedValue);
        if (jitCompiledValue !== null) {
            hasJitData = true;
        }
        if (classesLoadedValue !== null) {
            hasClassData = true;
        }

        // Parse GC time if available (7th column)
        if (row.columnCount >= 7 && row.gcTimeRaw) {
            // Remove 's' suffix if present and parse as float
            const gcTimeValue = parseFloat(row.gcTimeRaw.replace('s', ''));
            if (!isNaN(gcTimeValue)) {
                hasGcData = true;
                processData.gcTime!.push(gcTimeValue);
                processData.gcAvailable!.push(true);
            } else {
                processData.gcTime!.push(0);
                processData.gcAvailable!.push(false);
            }
        } else if (processData.gcTime) {
            // If GC data was expected but missing, push 0
            processData.gcTime.push(0);
            processData.gcAvailable!.push(false);
        }
    });

    const orderedTimestamps = Array.from(timestamps)
        .sort((a, b) => parseTimestampSeconds(a) - parseTimestampSeconds(b));
    return { processes, timestamps: orderedTimestamps, hasGcData, hasJitData, hasClassData };
}

function generateCsvReport(logFile: string, outputFile: string, hasGcData: boolean): void {
    const header = ['elapsed_time', 'pid', 'name', 'heap_used_mb', 'heap_capacity_mb', 'rss_mb', 'gc_time_s', 'jit_compiled_methods', 'jit_failed_compilations', 'jit_invalidated_compilations', 'jit_compilation_time_s', 'classes_loaded', 'classes_unloaded', 'class_load_time_s'];
    const rows = [header.join(',')];

    parseMonitorLogText(fs.readFileSync(logFile, 'utf8')).forEach(row => {
        const baseRow = [
            row.timestamp,
            row.pid,
            row.name,
            row.heapUsedMb,
            row.heapCapMb,
            row.rssMb
        ];
        baseRow.push(
            row.columnCount >= 7 && hasGcData
                ? (row.gcTimeRaw ?? '').replace('s', '').replace('N/A', '')
                : ''
        );
        baseRow.push(...Array.from({ length: 7 }, (_, index) => row.optionalMetricRaws[index]?.replace('N/A', '') ?? ''));
        rows.push(baseRow.join(','));
    });

    fs.writeFileSync(outputFile, rows.join('\n'));
}

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
        return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
}

function buildForwardFilledSeries(
    timestamps: string[],
    timestampSeconds: number[],
    valuesByTimestamp: Map<string, number>,
    maxGapSeconds: number
): Array<number | null> {
    const series: Array<number | null> = [];
    let lastValue: number | null = null;
    let lastSeenTime: number | null = null;

    for (let i = 0; i < timestamps.length; i += 1) {
        const timestamp = timestamps[i];
        const timeSeconds = timestampSeconds[i];
        const value = valuesByTimestamp.get(timestamp);

        if (value !== undefined && Number.isFinite(value)) {
            lastValue = value;
            lastSeenTime = timeSeconds;
            series.push(value);
            continue;
        }

        if (lastValue === null || lastSeenTime === null) {
            series.push(null);
            continue;
        }

        if (timeSeconds - lastSeenTime > maxGapSeconds) {
            lastValue = null;
            lastSeenTime = null;
            series.push(null);
            continue;
        }

        series.push(lastValue);
    }

    return series;
}

function buildPathFromSeries(
    series: Array<number | null>,
    xScale: number,
    yScale: number,
    height: number,
    margin: { bottom: number; left: number }
): string {
    let path = '';
    let started = false;

    for (let i = 0; i < series.length; i += 1) {
        const value = series[i];
        if (value === null || !Number.isFinite(value)) {
            started = false;
            continue;
        }
        const x = margin.left + (i * xScale);
        const y = height - margin.bottom - (value * yScale);
        if (!started) {
            path += `M ${x} ${y}`;
            started = true;
        } else {
            path += ` L ${x} ${y}`;
        }
    }

    return path;
}

function lightenHexColor(hex: string, amount: number): string {
    const normalized = hex.replace('#', '');
    if (normalized.length !== 6) return hex;
    const num = parseInt(normalized, 16);
    const r = Math.min(255, ((num >> 16) & 0xff) + amount);
    const g = Math.min(255, ((num >> 8) & 0xff) + amount);
    const b = Math.min(255, (num & 0xff) + amount);
    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

function escapeSvgText(value: string): string {
    return value.replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;'
    }[char] || char));
}

function lastNonNull(values: Array<number | null>): number | null {
    for (let i = values.length - 1; i >= 0; i -= 1) {
        if (values[i] !== null) {
            return values[i];
        }
    }
    return null;
}

function generateMetricSvg(
    processes: Map<string, ProcessData>,
    timestamps: string[],
    options: {
        title: string;
        yAxisLabel: string;
        valueSuffix?: string;
        noDataMessage: string;
        metric: (process: ProcessData) => Array<number | null>;
    }
): string {
    const width = 1400;
    const height = 800;
    const margin = {
        top: 60,
        right: 300,
        bottom: 100,
        left: 100
    };
    const timestampSeconds = timestamps.map(parseTimestampSeconds);
    const deltas = timestampSeconds.slice(1).map((value, index) => value - timestampSeconds[index]).filter(delta => delta > 0);
    const maxGapSeconds = (median(deltas) || 1) * 2;
    const processColors = [
        '#E4572E',
        '#29335C',
        '#A8C686',
        '#669BBC',
        '#F3A712',
        '#6A4C93',
        '#43AA8B',
        '#B370B0',
    ];

    const seriesByProcess = Array.from(processes.values()).map(process => {
        const valuesByTimestamp = new Map<string, number>();
        const values = options.metric(process);
        process.timestamps.forEach((timestamp, index) => {
            const value = values[index];
            if (value !== null && Number.isFinite(value)) {
                valuesByTimestamp.set(timestamp, value);
            }
        });
        return buildForwardFilledSeries(timestamps, timestampSeconds, valuesByTimestamp, maxGapSeconds);
    });

    const values = seriesByProcess.flatMap(series => series.filter((value): value is number => value !== null));
    const maxValue = values.length > 0 ? Math.max(...values) : 0;
    const yAxisMax = Math.max(1, Math.ceil(maxValue * 1.1));
    const xScale = (width - margin.left - margin.right) / (timestamps.length - 1) || 1;
    const yScale = (height - margin.top - margin.bottom) / yAxisMax;

    let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">\n`;
    svg += `<rect width="100%" height="100%" fill="#fff"/>\n`;
    svg += `<text x="${width/2}" y="40" text-anchor="middle" font-size="24" font-weight="bold">${escapeSvgText(options.title)}</text>\n`;

    let gridInterval = 1;
    if (yAxisMax > 10000) {
        gridInterval = 5000;
    } else if (yAxisMax > 1000) {
        gridInterval = 500;
    } else if (yAxisMax > 100) {
        gridInterval = 50;
    } else if (yAxisMax > 20) {
        gridInterval = 10;
    } else if (yAxisMax > 10) {
        gridInterval = 5;
    }

    for (let i = 0; i <= yAxisMax; i += gridInterval) {
        const y = height - margin.bottom - (i * yScale);
        svg += `<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="#e0e0e0" stroke-width="1" stroke-dasharray="5,5"/>\n`;
        svg += `<text x="${margin.left - 10}" y="${y + 5}" text-anchor="end" font-size="12" fill="#333">${i}${options.valueSuffix || ''}</text>\n`;
    }

    svg += `<line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="#333" stroke-width="2"/>\n`;
    svg += `<line x1="${margin.left}" y1="${height - margin.bottom}" x2="${margin.left}" y2="${margin.top}" stroke="#333" stroke-width="2"/>\n`;

    const labelInterval = Math.ceil(timestamps.length / 15);
    for (let i = 0; i < timestamps.length; i += labelInterval) {
        const x = margin.left + (i * xScale);
        svg += `<text x="${x}" y="${height - margin.bottom + 20}" transform="rotate(45 ${x},${height - margin.bottom + 20})" text-anchor="start" font-size="12" fill="#333">${escapeSvgText(timestamps[i])}</text>\n`;
    }

    if (maxValue <= 0) {
        svg += `<text x="${width/2}" y="${height/2}" text-anchor="middle" font-size="18" fill="#64748b">${escapeSvgText(options.noDataMessage)}</text>\n`;
        svg += '</svg>';
        return svg;
    }

    let legendY = margin.top + 30;
    Array.from(processes.entries()).forEach(([key], idx) => {
        const series = seriesByProcess[idx];
        const path = buildPathFromSeries(series, xScale, yScale, height, { left: margin.left, bottom: margin.bottom });
        if (!path) return;
        const color = processColors[idx % processColors.length];
        svg += `<path d="${path}" stroke="${color}" stroke-width="2.5" fill="none" opacity="0.95"/>\n`;
        svg += `<rect x="${width - margin.right + 40}" y="${legendY - 10}" width="20" height="6" fill="${color}" opacity="0.95"/>\n`;
        svg += `<text x="${width - margin.right + 70}" y="${legendY - 2}" font-size="14" fill="#333">${escapeSvgText(key)}</text>\n`;
        legendY += 30;
    });

    svg += `<text x="${width/2}" y="${height - 10}" text-anchor="middle" font-size="16" fill="#333">Time</text>\n`;
    svg += `<text x="${margin.left - 60}" y="${height/2}" text-anchor="middle" transform="rotate(-90 ${margin.left - 60},${height/2})" font-size="16" fill="#333">${escapeSvgText(options.yAxisLabel)}</text>\n`;
    svg += '</svg>';
    return svg;
}

function generateSvg(processes: Map<string, ProcessData>, timestamps: string[]): string {
    const width = 1400;
    const height = 800;
    const margin = {
        top: 60,
        right: 300,
        bottom: 100,
        left: 100
    };

    const timestampSeconds = timestamps.map(parseTimestampSeconds);
    const deltas = timestampSeconds.slice(1).map((value, index) => value - timestampSeconds[index]).filter(delta => delta > 0);
    const medianDelta = median(deltas) || 1;
    const maxGapSeconds = medianDelta * 2;

    const perProcessRss: Array<Array<number | null>> = [];
    const perProcessHeap: Array<Array<number | null>> = [];

    Array.from(processes.values()).forEach(process => {
        const rssMap = new Map<string, number>();
        const heapMap = new Map<string, number>();
        process.timestamps.forEach((timestamp, index) => {
            const rssValue = process.rss[index];
            const heapValue = process.heapUsed[index];
            if (Number.isFinite(rssValue)) {
                rssMap.set(timestamp, rssValue);
            }
            if (Number.isFinite(heapValue)) {
                heapMap.set(timestamp, heapValue);
            }
        });
        perProcessRss.push(buildForwardFilledSeries(timestamps, timestampSeconds, rssMap, maxGapSeconds));
        perProcessHeap.push(buildForwardFilledSeries(timestamps, timestampSeconds, heapMap, maxGapSeconds));
    });

    const activeCounts: number[] = [];
    const aggregatedRss = timestamps.map((_, index) => {
        let hasValue = false;
        let activeCount = 0;
        const sum = perProcessRss.reduce((total, series) => {
            const value = series[index];
            if (value === null || !Number.isFinite(value)) {
                return total;
            }
            hasValue = true;
            activeCount += 1;
            return total + value;
        }, 0);
        activeCounts.push(activeCount);
        return hasValue ? sum : null;
    });

    // Calculate scales using max of individual processes and aggregated
    const rssValues = perProcessRss.flatMap(series => series.filter((value): value is number => value !== null));
    const maxIndividualRss = rssValues.length > 0 ? Math.max(...rssValues) : 0;
    const aggregatedValues = aggregatedRss.filter((value): value is number => value !== null);
    const maxAggregatedRss = aggregatedValues.length > 0 ? Math.max(...aggregatedValues) : 0;
    const maxRss = Math.max(maxIndividualRss, maxAggregatedRss);

    if (aggregatedValues.length > 0) {
        const maxActiveCount = Math.max(...activeCounts);
        if (maxActiveCount >= 2) {
            const tailThreshold = maxAggregatedRss * 0.2;
            for (let i = aggregatedRss.length - 1; i >= 0; i -= 1) {
                const value = aggregatedRss[i];
                if (value === null) {
                    continue;
                }
                if (activeCounts[i] <= 1 && value <= tailThreshold) {
                    aggregatedRss[i] = null;
                    continue;
                }
                break;
            }
        }
    }
    
    // Scale based on observed max to improve visibility
    const yAxisMax = Math.max(50, Math.ceil(maxRss * 1.1));
    const xScale = (width - margin.left - margin.right) / (timestamps.length - 1) || 1;
    const yScale = (height - margin.top - margin.bottom) / yAxisMax;

    // Improved color palette for clarity
    const processColors = [
        '#E4572E', // Red-Orange
        '#29335C', // Navy
        '#A8C686', // Green
        '#669BBC', // Blue
        '#F3A712', // Yellow
        '#6A4C93', // Purple
        '#43AA8B', // Teal
        '#B370B0', // Magenta
    ];
    const aggRssColor = '#222'; // Black for Aggregated RSS
    const aggHeapColor = '#1976D2'; // Blue for Aggregated Heap Used

    // Generate SVG content
    let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">\n`;
    svg += `<rect width="100%" height="100%" fill="#fff"/>\n`;
    // Add title
    svg += `<text x="${width/2}" y="40" text-anchor="middle" font-size="24" font-weight="bold">Build Process Memory Usage Over Time</text>\n`;

    // Add grid lines (dynamic interval)
    let gridInterval = 1000;
    if (yAxisMax <= 200) {
        gridInterval = 20;
    } else if (yAxisMax <= 1000) {
        gridInterval = 100;
    } else if (yAxisMax <= 5000) {
        gridInterval = 500;
    }
    for (let i = 0; i <= yAxisMax; i += gridInterval) {
        const y = height - margin.bottom - (i * yScale);
        svg += `<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="#e0e0e0" stroke-width="1" stroke-dasharray="5,5"/>\n`;
    }

    // Draw axes
    svg += `<line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="#333" stroke-width="2"/>\n`;
    svg += `<line x1="${margin.left}" y1="${height - margin.bottom}" x2="${margin.left}" y2="${margin.top}" stroke="#333" stroke-width="2"/>\n`;

    // Draw Y axis labels (every 500MB)
    for (let i = 0; i <= yAxisMax; i += gridInterval) {
        const y = height - margin.bottom - (i * yScale);
        svg += `<text x="${margin.left - 10}" y="${y + 5}" text-anchor="end" font-size="12" fill="#333">${i}MB</text>\n`;
    }

    // Draw X axis labels (dynamic interval based on timestamp count)
    const labelInterval = Math.ceil(timestamps.length / 15); // Show ~15 labels
    for (let i = 0; i < timestamps.length; i += labelInterval) {
        const x = margin.left + (i * xScale);
        svg += `<text x="${x}" y="${height - margin.bottom + 20}" transform="rotate(45 ${x},${height - margin.bottom + 20})" text-anchor="start" font-size="12" fill="#333">${timestamps[i]}</text>\n`;
    }

    // Draw process lines and legend
    let legendY = margin.top + 30;
    Array.from(processes.entries()).forEach(([key], idx) => {
        const color = processColors[idx % processColors.length];
        const heapColor = lightenHexColor(color, 80);
        const rssSeries = perProcessRss[idx];
        const heapSeries = perProcessHeap[idx];
        // RSS line (solid)
        const rssPath = buildPathFromSeries(rssSeries, xScale, yScale, height, { left: margin.left, bottom: margin.bottom });
        if (rssPath) {
            svg += `<path d="${rssPath}" stroke="${color}" stroke-width="2.5" fill="none" opacity="0.95"/>\n`;
        }

        // Heap Used line (dashed)
        const heapPath = buildPathFromSeries(heapSeries, xScale, yScale, height, { left: margin.left, bottom: margin.bottom });
        if (heapPath) {
            svg += `<path d="${heapPath}" stroke="${heapColor}" stroke-width="3" fill="none" opacity="0.9" stroke-dasharray="12,6"/>\n`;
        }

        // Legend for this process
        svg += `<rect x="${width - margin.right + 40}" y="${legendY - 10}" width="20" height="6" fill="${color}" opacity="0.95"/>\n`;
        svg += `<text x="${width - margin.right + 70}" y="${legendY - 2}" font-size="14" fill="#333">${key} (RSS)</text>\n`;
        svg += `<line x1="${width - margin.right + 40}" y1="${legendY + 13}" x2="${width - margin.right + 60}" y2="${legendY + 13}" stroke="${heapColor}" stroke-width="3" stroke-dasharray="12,6"/>\n`;
        svg += `<text x="${width - margin.right + 70}" y="${legendY + 18}" font-size="14" fill="#333">${key} (Heap Used)</text>\n`;
        legendY += 40;
    });

    // Draw aggregated RSS line (black, solid)
    const aggregatedPath = buildPathFromSeries(aggregatedRss, xScale, yScale, height, { left: margin.left, bottom: margin.bottom });
    if (aggregatedPath) {
        svg += `<path d="${aggregatedPath}" stroke="${aggRssColor}" stroke-width="3.5" fill="none" opacity="0.9"/>\n`;
    }
    // Aggregated legend
    svg += `<rect x="${width - margin.right + 40}" y="${legendY - 10}" width="20" height="20" fill="${aggRssColor}" opacity="0.9"/>\n`;
    svg += `<text x="${width - margin.right + 70}" y="${legendY + 5}" font-size="14" fill="#333">Aggregated RSS</text>\n`;

    // Add axis labels
    svg += `<text x="${width/2}" y="${height - 10}" text-anchor="middle" font-size="16" fill="#333">Time</text>\n`;
    svg += `<text x="${margin.left - 60}" y="${height/2}" text-anchor="middle" transform="rotate(-90 ${margin.left - 60},${height/2})" font-size="16" fill="#333">Memory Usage (MB)</text>\n`;

    svg += '</svg>';
    return svg;
}

function generateGcSvg(processes: Map<string, ProcessData>, timestamps: string[]): string {
    const width = 1400;
    const height = 800;
    const margin = {
        top: 60,
        right: 300,
        bottom: 100,
        left: 100
    };

    // Calculate aggregated GC time
    const aggregatedGcTime = timestamps.map(timestamp => {
        return Array.from(processes.values())
            .filter(p => p.timestamps.includes(timestamp) && p.gcTime)
            .reduce((sum, p) => {
                const idx = p.timestamps.indexOf(timestamp);
                return sum + (p.gcTime?.[idx] || 0);
            }, 0);
    });

    const gcValues = Array.from(processes.values())
        .filter(p => p.gcTime && p.gcTime.length > 0)
        .flatMap(p => p.gcTime || []);
    const maxIndividualGc = gcValues.length > 0 ? Math.max(...gcValues) : 0;
    const maxAggregatedGc = Math.max(...aggregatedGcTime);
    const maxGc = Math.max(maxIndividualGc, maxAggregatedGc);
    
    const yAxisMax = Math.max(0.1, maxGc * 1.1);
    const xScale = (width - margin.left - margin.right) / (timestamps.length - 1) || 1;
    const yScale = (height - margin.top - margin.bottom) / yAxisMax;

    // Color palette for GC charts
    const processColors = [
        '#E4572E', // Red-Orange
        '#29335C', // Navy
        '#A8C686', // Green
        '#669BBC', // Blue
        '#F3A712', // Yellow
        '#6A4C93', // Purple
        '#43AA8B', // Teal
        '#B370B0', // Magenta
    ];
    const aggGcColor = '#DC2626'; // Red for Aggregated GC Time

    // Generate SVG content
    let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">\n`;
    svg += `<rect width="100%" height="100%" fill="#fff"/>\n`;
    // Add title
    svg += `<text x="${width/2}" y="40" text-anchor="middle" font-size="24" font-weight="bold">Build Process GC Time Over Time</text>\n`;

    // Add grid lines (dynamic interval)
    let gridInterval = 0.1;
    if (yAxisMax > 1 && yAxisMax <= 5) {
        gridInterval = 0.5;
    } else if (yAxisMax > 5 && yAxisMax <= 20) {
        gridInterval = 1;
    } else if (yAxisMax > 20) {
        gridInterval = 5;
    }
    for (let i = 0; i <= yAxisMax; i += gridInterval) {
        const y = height - margin.bottom - (i * yScale);
        svg += `<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="#e0e0e0" stroke-width="1" stroke-dasharray="5,5"/>\n`;
    }

    // Draw axes
    svg += `<line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="#333" stroke-width="2"/>\n`;
    svg += `<line x1="${margin.left}" y1="${height - margin.bottom}" x2="${margin.left}" y2="${margin.top}" stroke="#333" stroke-width="2"/>\n`;

    // Draw Y axis labels (every 0.1s)
    for (let i = 0; i <= yAxisMax; i += gridInterval) {
        const y = height - margin.bottom - (i * yScale);
        if (i % 0.5 === 0 || i === 0) { // Show labels every 0.5s
            svg += `<text x="${margin.left - 10}" y="${y + 5}" text-anchor="end" font-size="12" fill="#333">${i.toFixed(1)}s</text>\n`;
        }
    }

    // Draw X axis labels (dynamic interval based on timestamp count)
    const labelInterval = Math.ceil(timestamps.length / 15); // Show ~15 labels
    for (let i = 0; i < timestamps.length; i += labelInterval) {
        const x = margin.left + (i * xScale);
        svg += `<text x="${x}" y="${height - margin.bottom + 20}" transform="rotate(45 ${x},${height - margin.bottom + 20})" text-anchor="start" font-size="12" fill="#333">${timestamps[i]}</text>\n`;
    }

    if (maxGc <= 0) {
        svg += `<text x="${width/2}" y="${height/2}" text-anchor="middle" font-size="18" fill="#64748b">No GC data available</text>\n`;
        svg += '</svg>';
        return svg;
    }

    // Draw process GC time lines and legend
    let legendY = margin.top + 30;
    Array.from(processes.entries()).forEach(([key, data], idx) => {
        if (!data.gcTime || data.gcTime.length === 0) return;
        
        const color = processColors[idx % processColors.length];
        // GC time line (solid)
        const gcPoints = data.timestamps.map((timestamp, i) => {
            const x = margin.left + (timestamps.indexOf(timestamp) * xScale);
            const y = height - margin.bottom - ((data.gcTime?.[i] || 0) * yScale);
            return `${x},${y}`;
        }).join(' ');
        svg += `<polyline points="${gcPoints}" stroke="${color}" stroke-width="2.5" fill="none" opacity="0.95"/>\n`;

        // Legend for this process
        svg += `<rect x="${width - margin.right + 40}" y="${legendY - 10}" width="20" height="6" fill="${color}" opacity="0.95"/>\n`;
        svg += `<text x="${width - margin.right + 70}" y="${legendY - 2}" font-size="14" fill="#333">${key} (GC Time)</text>\n`;
        legendY += 30;
    });

    // Add axis labels
    svg += `<text x="${width/2}" y="${height - 10}" text-anchor="middle" font-size="16" fill="#333">Time</text>\n`;
    svg += `<text x="${margin.left - 60}" y="${height/2}" text-anchor="middle" transform="rotate(-90 ${margin.left - 60},${height/2})" font-size="16" fill="#333">GC Time (seconds)</text>\n`;

    svg += '</svg>';
    return svg;
}

async function markProcessAsFinished(runId: string): Promise<void> {
    try {
        let backendUrl = '';
        const workspaceDir = process.env.GITHUB_WORKSPACE;
        const runnerTempDir = process.env.RUNNER_TEMP;
        const candidateDirs = resolveActionRuntimeStateCandidateDirs({
            cwd: process.cwd(),
            workspaceDir,
            runnerTempRoot: runnerTempDir,
            runId,
        });
        for (const dir of candidateDirs) {
            const backendFile = actionRuntimeStateFilePath(dir, ACTION_RUNTIME_STATE_FILES.backendUrl);
            if (fs.existsSync(backendFile)) {
                backendUrl = fs.readFileSync(backendFile, 'utf8').trim();
                break;
            }
        }
        const backendEnabled = process.env.ENABLE_BACKEND === 'true';
        
        if (!backendEnabled) {
            console.log(`ℹ️  Remote monitoring disabled; skipping finish for run ${runId}`);
            return;
        }

        if (backendUrl) {
            // Use backend API to mark as finished
            console.log(`🏁 Marking run ${runId} as finished via backend API...`);
            
            // Get JWT token for this run
            console.log(`🔐 Requesting JWT token for run ${runId}...`);
            // Empty body ensures Content-Length is sent (avoids HTTP 411 on some proxies).
            const authResponse = await fetch(`${backendUrl}/auth/run/${runId}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: '',
            });
            
            if (!authResponse.ok) {
                const errorText = await authResponse.text().catch(() => 'Unknown error');
                console.error(`❌ Failed to get JWT token: ${authResponse.status} ${authResponse.statusText}`);
                console.error(`   Error details: ${errorText}`);
                console.log(`🔄 Falling back to direct Firestore update...`);
                await markProcessAsFinishedDirect(runId);
                return;
            }
            
            const authData = await authResponse.json();
            const token = authData.token;
            console.log(`✅ JWT token obtained for run ${runId}`);
            
            // Call finish endpoint with JWT token
            // Empty body ensures Content-Length is sent (avoids HTTP 411 on some proxies).
            const response = await fetch(`${backendUrl}/finish/${runId}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                },
                body: '',
            });
            
            if (response.ok) {
                const result = await response.json();
                console.log(`✅ Successfully marked run ${runId} as finished via backend: ${result.message || 'OK'}`);
            } else {
                const errorText = await response.text().catch(() => 'Unknown error');
                console.error(`❌ Backend API failed to mark run as finished: ${response.status} ${response.statusText}`);
                console.error(`   Error details: ${errorText}`);
                console.log(`🔄 Falling back to direct Firestore update...`);
                // Fall back to direct Firestore update
                await markProcessAsFinishedDirect(runId);
            }
        } else {
            console.log(`🏁 Backend URL not available, using direct Firestore update for run ${runId}...`);
            // Fall back to direct Firestore update
            await markProcessAsFinishedDirect(runId);
        }
    } catch (error) {
        console.error(`❌ Error marking process as finished for run ${runId}:`, error);
        // Try direct Firestore update as last resort
        try {
            console.log(`🔄 Attempting direct Firestore update as last resort...`);
            await markProcessAsFinishedDirect(runId);
        } catch (directError) {
            console.error(`❌ Direct Firestore update also failed:`, directError);
        }
        // Don't throw error - this is not critical for the cleanup process
    }
}

async function markProcessAsFinishedDirect(runId: string): Promise<void> {
    try {
        // Initialize Firebase Admin SDK
        const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || './test-key-new.json';
        const projectId = process.env.GOOGLE_CLOUD_PROJECT || 'process-watcher-68e14';
        
        if (!fs.existsSync(serviceAccountPath)) {
            console.log(`⚠️  Service account key not found at ${serviceAccountPath}, skipping direct Firestore update`);
            console.log(`   This is expected in GitHub Actions - backend API should be used instead`);
            return;
        }

        console.log(`🔧 Initializing Firebase Admin SDK for direct Firestore update...`);
        initializeApp({
            credential: cert(serviceAccountPath),
            projectId: projectId
        });

        const db = getFirestore();
        const docRef = db.collection('runs').doc(runId);
        
        // Update the document to mark it as finished
        const now = new Date();
        await docRef.update({
            finished: true,
            finished_at: now,
            updated_at: now
        });
        
        console.log(`✅ Marked run ${runId} as finished in Firestore directly at ${now.toISOString()}`);
    } catch (error) {
        console.error(`❌ Error marking process as finished directly for run ${runId}:`, error);
        // Don't throw error - this is not critical for the cleanup process
    }
}

// File-based lock to prevent multiple cleanup runs across different processes
const LOCK_FILE = 'cleanup.lock';

function acquireLock(): boolean {
    try {
        // Try to create lock file exclusively
        const fd = fs.openSync(LOCK_FILE, 'wx');
        fs.closeSync(fd);
        return true;
    } catch (error) {
        // Lock file exists or other error - cleanup already running
        return false;
    }
}

function releaseLock(): void {
    try {
        if (fs.existsSync(LOCK_FILE)) {
            fs.unlinkSync(LOCK_FILE);
        }
    } catch (error) {
        // Ignore errors when releasing lock
    }
}

function removeIfExists(filePath: string, debugMode: boolean): void {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            if (debugMode) {
                console.log(`🧹 Removed temporary file: ${filePath}`);
            }
        }
    } catch (error) {
        if (debugMode) {
            console.log(`⚠️  Could not remove temporary file ${filePath}: ${error instanceof Error ? error.message : error}`);
        }
    }
}

function copyIfExists(sourcePath: string, destinationDir: string, debugMode: boolean): void {
    try {
        if (!fs.existsSync(sourcePath)) return;
        const destinationPath = path.join(destinationDir, path.basename(sourcePath));
        if (path.resolve(sourcePath) === path.resolve(destinationPath)) return;
        fs.copyFileSync(sourcePath, destinationPath);
        if (debugMode) {
            console.log(`📦 Copied artifact to workspace: ${destinationPath}`);
        }
    } catch (error) {
        if (debugMode) {
            console.log(`⚠️  Could not copy artifact ${sourcePath}: ${error instanceof Error ? error.message : error}`);
        }
    }
}

function cleanupWorkspaceLeftovers(logFile: string | null, debugMode: boolean): void {
    const workspaceDir = process.env.GITHUB_WORKSPACE;
    const runnerTempDir = process.env.RUNNER_TEMP;
    const runId = process.env.RUN_ID;
    const defaultLogFile = process.env.BPW_LOG_FILE_DEFAULT !== 'false';
    const candidateDirs = resolveActionRuntimeStateCandidateDirs({
        cwd: process.cwd(),
        workspaceDir,
        runnerTempRoot: runnerTempDir,
        runId,
        includeRunnerTempRoot: true,
    });

    candidateDirs.forEach(dir => {
        ACTION_RUNTIME_STATE_FILE_NAMES.forEach(file => removeIfExists(actionRuntimeStateFilePath(dir, file), debugMode));
    });

    if (logFile && defaultLogFile) {
        removeIfExists(logFile, debugMode);
        removeIfExists(logFile.replace(/\.log$/, '.process_info'), debugMode);
    }

    if (workspaceDir && runId && defaultLogFile) {
        const outputSuffix = `-${runId}`;
        [
            'build_process_watcher.log',
            'build_process_watcher.process_info',
            `memory_usage${outputSuffix}.svg`,
            `gc_time${outputSuffix}.svg`,
            `jit_compilation${outputSuffix}.svg`,
            `class_loading${outputSuffix}.svg`,
            `build_process_watcher${outputSuffix}.csv`,
            `build_process_watcher${outputSuffix}.json`
        ].forEach(file => removeIfExists(path.join(workspaceDir, file), debugMode));
    }
}

async function run() {
    // Prevent multiple cleanup executions using file-based lock
    if (!acquireLock()) {
        const debugMode = process.env.DEBUG_MODE === 'true';
        if (debugMode) {
            console.log('⚠️  Cleanup already running, skipping duplicate execution');
        }
        return;
    }
    const debugMode = process.env.DEBUG_MODE === 'true';
    const isTrapHandler = process.env.CLEANUP_FROM_TRAP === 'true';
    let resolvedLogFile: string | null = null;
    
    try {
        
        // Check debug mode from environment variable
        
        // Kill the monitor process if it's still running
        try {
            const pid = fs.readFileSync('monitor.pid', 'utf8').trim();
            process.kill(parseInt(pid));
            if (debugMode) {
                console.log(`Killed monitor process with PID ${pid}`);
            }
        } catch (error) {
            if (debugMode) {
                console.log('No monitor process found to kill');
            }
        }

        // Mark the process as finished in Firestore if we have a run ID
        // Try multiple ways to get the RUN_ID (in order of preference):
        // 1. From environment variable (exported by main step)
        // 2. From the backup file written by the main step
        // 3. From backend debug log (if it exists and contains run_id)
        // 4. From GitHub run ID (last resort fallback)
        let runId = process.env.RUN_ID;
        
        // Try to read from file if not in env var
        if (!runId) {
            try {
                const workspaceDir = process.env.GITHUB_WORKSPACE;
                const runnerTempDir = process.env.RUNNER_TEMP;
                const runtimeTempRoot = runnerTempDir ? getActionRuntimeTempRoot(runnerTempDir) : '';
                const tempRunEntries = runtimeTempRoot && fs.existsSync(runtimeTempRoot)
                    ? fs.readdirSync(runtimeTempRoot)
                    : [];
                const candidateFiles = resolveRunIdBackupCandidateFiles({
                    cwd: process.cwd(),
                    workspaceDir,
                    runnerTempRoot: runnerTempDir,
                    runnerTempRunEntries: tempRunEntries,
                });

                for (const runIdFile of candidateFiles) {
                    if (fs.existsSync(runIdFile)) {
                        runId = fs.readFileSync(runIdFile, 'utf8').trim();
                        console.log(`📋 Read RUN_ID from file: ${runId}`);
                        break;
                    }
                }
            } catch (error) {
                // Ignore errors when reading file
            }
        }
        
        // Try to extract RUN_ID from backend debug log if still not found
        if (!runId) {
            const actionDir = process.env.GITHUB_ACTION_PATH || __dirname;
            const backendDebugLog = path.join(actionDir, '..', 'backend_debug.log');
            if (fs.existsSync(backendDebugLog)) {
                try {
                    const logContent = fs.readFileSync(backendDebugLog, 'utf8');
                    // Look for "Run ID: run-xxxxx" pattern in the log
                    const runIdMatch = logContent.match(/Run ID:\s*(run-\d+)/i) || 
                                     logContent.match(/run_id[":\s]+(run-\d+)/i) ||
                                     logContent.match(/Run ID:\s*(build-\d+)/i);
                    if (runIdMatch && runIdMatch[1]) {
                        runId = runIdMatch[1];
                        console.log(`📋 Extracted RUN_ID from log file: ${runId}`);
                    }
                } catch (error) {
                    // Ignore errors when reading log file
                }
            }
        }
        
        // Last resort: use GitHub run ID (but only if it looks like our format)
        if (!runId && process.env.GITHUB_RUN_ID) {
            // Only use GITHUB_RUN_ID if it matches our pattern (run-xxx or build-xxx)
            const githubRunId = process.env.GITHUB_RUN_ID;
            if (githubRunId.match(/^(run-|build-)\d+$/)) {
                runId = githubRunId;
                console.log(`📋 Using GITHUB_RUN_ID as fallback: ${runId}`);
            }
        }
        
        // Only mark as finished for remote monitoring runs
        if (runId && process.env.ENABLE_BACKEND === 'true') {
            console.log(`🏁 Marking run ${runId} as finished...`);
            try {
                await markProcessAsFinished(runId);
            } catch (error) {
                console.error(`❌ Failed to mark run ${runId} as finished:`, error);
                // Don't throw - we want cleanup to continue even if marking fails
            }
        } else if (runId) {
            console.log(`ℹ️  Remote monitoring disabled; skipping finish for run ${runId}`);
        } else {
            console.log('⚠️  No run ID found, skipping Firestore update');
            console.log('   Available env vars:', Object.keys(process.env).filter(k => k.includes('RUN') || k.includes('GITHUB')).join(', ') || 'none');
        }

        // Print backend debug log if it exists (only in debug mode)
        const actionDir = process.env.GITHUB_ACTION_PATH || __dirname;
        const backendDebugLog = path.join(actionDir, '..', 'backend_debug.log');
        if (fs.existsSync(backendDebugLog) && debugMode) {
            console.log('\n🔍 Backend Debug Log:');
            console.log('==========================================');
            const debugContent = fs.readFileSync(backendDebugLog, 'utf8');
            console.log(debugContent);
            console.log('==========================================\n');
        }

        // Print script debug log if it exists (only in debug mode)
        const scriptDebugLog = path.join(actionDir, '..', 'script_debug.log');
        if (fs.existsSync(scriptDebugLog) && debugMode) {
            console.log('\n🔍 Script Debug Log:');
            console.log('==========================================');
            const scriptDebugContent = fs.readFileSync(scriptDebugLog, 'utf8');
            console.log(scriptDebugContent);
            console.log('==========================================\n');
        }

        // Print summary statistics if available (for backend mode)
        const successfulCallsFile = path.join(actionDir, '..', 'successful_calls_count.txt');
        const failedCallsFile = path.join(actionDir, '..', 'failed_calls_count.txt');
        
        let successfulCount = 0;
        let failedCount = 0;
        let hasStats = false;
        
        if (fs.existsSync(successfulCallsFile)) {
            try {
                const successfulCalls = fs.readFileSync(successfulCallsFile, 'utf8').trim();
                const count = parseInt(successfulCalls, 10);
                if (!isNaN(count)) {
                    successfulCount = count;
                    hasStats = true;
                }
            } catch (error) {
                // Silently ignore errors reading the file
            }
        }
        
        if (fs.existsSync(failedCallsFile)) {
            try {
                const failedCalls = fs.readFileSync(failedCallsFile, 'utf8').trim();
                const count = parseInt(failedCalls, 10);
                if (!isNaN(count)) {
                    failedCount = count;
                    hasStats = true;
                }
            } catch (error) {
                // Silently ignore errors reading the file
            }
        }
        
        if (hasStats) {
            const totalCalls = successfulCount + failedCount;
            const successRate = totalCalls > 0 ? ((successfulCount / totalCalls) * 100).toFixed(1) : '0.0';
            
            console.log('');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('📊 Build Process Watcher - Summary Statistics');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log(`✅ Total successful backend calls: ${successfulCount}`);
            console.log(`❌ Total failed backend calls: ${failedCount}`);
            console.log(`📈 Total calls: ${totalCalls}`);
            console.log(`📊 Success rate: ${successRate}%`);
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('');
        }

        // Check if we have a log file
        // The monitor script creates files in the action directory, not the project directory
        const logFileName = process.env.LOG_FILE || 'build_process_watcher.log';
        let logFile = logFileName;
        if (!path.isAbsolute(logFileName)) {
            const workspaceDir = process.env.GITHUB_WORKSPACE;
            const runnerTempDir = process.env.RUNNER_TEMP;
            const runTempDir = runnerTempDir && runId ? getActionRunTempDir(runnerTempDir, runId) : '';
            const candidates = [
                runTempDir ? path.join(runTempDir, logFileName) : '',
                path.join(actionDir, '..', logFileName),
                workspaceDir ? path.join(workspaceDir, logFileName) : ''
            ].filter(Boolean);
            logFile = candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
        }
        resolvedLogFile = logFile;
        const backendMode = process.env.ENABLE_BACKEND === 'true';
        
        if (debugMode) {
            console.log(`🔍 Debug: Current working directory: ${process.cwd()}`);
            console.log(`🔍 Debug: Looking for log file: ${logFile}`);
            console.log(`🔍 Debug: Log file exists: ${fs.existsSync(logFile)}`);
            console.log(`🔍 Debug: Backend mode: ${backendMode}`);
            
            // List all files in current directory
            try {
                const files = fs.readdirSync('.');
                console.log(`🔍 Debug: Files in current directory: ${files.join(', ')}`);
            } catch (err) {
                console.log(`🔍 Debug: Error listing directory: ${err}`);
            }
        }
        
        if (!fs.existsSync(logFile)) {
            if (backendMode) {
                // Always show the dashboard URL for remote monitoring
                // Check if frontend URL is explicitly set, otherwise derive from backend URL or environment
                let frontendUrl = '';
                let explicitFrontendUrl = '';
                const workspaceDir = process.env.GITHUB_WORKSPACE;
                const runnerTempDir = process.env.RUNNER_TEMP;
                const candidateDirs = resolveActionRuntimeStateCandidateDirs({
                    cwd: process.cwd(),
                    workspaceDir,
                    runnerTempRoot: runnerTempDir,
                    runId,
                });
                for (const dir of candidateDirs) {
                    const frontendFile = actionRuntimeStateFilePath(dir, ACTION_RUNTIME_STATE_FILES.frontendUrl);
                    if (fs.existsSync(frontendFile)) {
                        explicitFrontendUrl = fs.readFileSync(frontendFile, 'utf8').trim();
                        break;
                    }
                }
                
                if (explicitFrontendUrl) {
                    // Use explicit frontend URL
                    frontendUrl = `${explicitFrontendUrl}/runs/${runId}`;
                } else {
                    // Derive frontend URL from backend URL pattern or environment
                    let baseFrontendUrl = 'https://process-watcher.web.app';
                    
                    frontendUrl = `${baseFrontendUrl}/runs/${runId}`;
                }
                
                console.log(`🌐 Dashboard URL: ${frontendUrl}`);
                
                if (debugMode) {
                    console.log('Backend mode detected - no local log file to process');
                    console.log('Data has been sent to the backend and can be viewed at:');
                    console.log(`- Frontend: ${frontendUrl}`);
                }
            } else {
                if (debugMode) {
                    console.log('No log file found');
                }
            }
            return;
        }

        // Parse log file
        if (debugMode) {
            console.log('Generating memory usage graph...');
        }
        const { processes, timestamps, hasGcData, hasJitData, hasClassData } = parseLogFile(logFile);
        
        // Generate both charts
        const mermaidChart = generateCombinedMermaidChart(processes, timestamps);
        const svgContent = generateSvg(processes, timestamps);

        const outputDir = path.dirname(logFile);
        const outputSuffix = runId ? `-${runId}` : '';
        const memorySvgFile = `memory_usage${outputSuffix}.svg`;
        const gcSvgFile = `gc_time${outputSuffix}.svg`;
        const jitSvgFile = `jit_compilation${outputSuffix}.svg`;
        const classSvgFile = `class_loading${outputSuffix}.svg`;
        const csvFile = `build_process_watcher${outputSuffix}.csv`;
        const jsonFile = `build_process_watcher${outputSuffix}.json`;

        // Save SVG file
        fs.writeFileSync(path.join(outputDir, memorySvgFile), svgContent);

        // Generate GC SVG (includes a fallback message if no GC data)
        if (debugMode) {
            console.log('Generating GC time graph...');
        }
        const gcSvgContent = generateGcSvg(processes, timestamps);
        fs.writeFileSync(path.join(outputDir, gcSvgFile), gcSvgContent);

        if (hasJitData) {
            if (debugMode) {
                console.log('Generating JIT compilation graph...');
            }
            const jitSvgContent = generateMetricSvg(processes, timestamps, {
                title: 'Build Process JIT Compiled Methods Over Time',
                yAxisLabel: 'Compiled Methods',
                noDataMessage: 'No JIT compilation data available',
                metric: process => process.jitCompiledMethods
            });
            fs.writeFileSync(path.join(outputDir, jitSvgFile), jitSvgContent);
        }

        if (hasClassData) {
            if (debugMode) {
                console.log('Generating class loading graph...');
            }
            const classSvgContent = generateMetricSvg(processes, timestamps, {
                title: 'Build Process Classes Loaded Over Time',
                yAxisLabel: 'Classes Loaded',
                noDataMessage: 'No class loading data available',
                metric: process => process.classesLoaded
            });
            fs.writeFileSync(path.join(outputDir, classSvgFile), classSvgContent);
        }

        generateCsvReport(logFile, path.join(outputDir, csvFile), hasGcData);
        generateJsonReport(logFile, path.join(outputDir, jsonFile), hasGcData);

        const workspaceDir = process.env.GITHUB_WORKSPACE;
        if (workspaceDir && path.resolve(outputDir) !== path.resolve(workspaceDir)) {
            [
                logFile,
                logFile.replace(/\.log$/, '.process_info'),
                path.join(outputDir, memorySvgFile),
                path.join(outputDir, gcSvgFile),
                path.join(outputDir, jitSvgFile),
                path.join(outputDir, classSvgFile),
                path.join(outputDir, csvFile),
                path.join(outputDir, jsonFile)
            ].forEach(file => copyIfExists(file, workspaceDir, debugMode));
        }

        // Upload artifacts (only if files exist)
        // Only upload artifacts if we're in a GitHub Actions context and have runtime token
        // When called from script trap, we might not have the token, so skip upload
        const isGitHubActions = process.env.GITHUB_ACTIONS === 'true';
        const hasRuntimeToken = process.env.ACTIONS_RUNTIME_TOKEN !== undefined || 
                               process.env.GITHUB_TOKEN !== undefined;
        let uploadedArtifact: { name: string, files: string[] } | null = null;
        
        // Check if we're being called from a trap handler (they set a marker env var)
        // or if we're the first cleanup (post action) - only upload once
        const shouldUpload = !isTrapHandler && isGitHubActions && hasRuntimeToken;
        
        if (shouldUpload) {
            try {
                const { DefaultArtifactClient } = await import('@actions/artifact');
                const artifactClient = new DefaultArtifactClient();
                // Create stable artifact name using job name and run attempt
                const jobName = process.env.GITHUB_JOB || 'default';
                const runAttempt = process.env.GITHUB_RUN_ATTEMPT || '1';
                
                // Use job name in artifact name (run attempt avoids duplicates on re-runs)
                const artifactName = `build_process_watcher-${jobName}-${runAttempt}`;
                
                const artifactCandidates = [
                    logFile,
                    path.join(outputDir, memorySvgFile),
                    path.join(outputDir, gcSvgFile),
                    path.join(outputDir, jitSvgFile),
                    path.join(outputDir, classSvgFile),
                    path.join(outputDir, csvFile),
                    path.join(outputDir, jsonFile)
                ];
                if (debugMode) {
                    const backendDebugLog = path.join(actionDir, '..', 'backend_debug.log');
                    if (fs.existsSync(backendDebugLog)) {
                        const debugCopy = path.join(outputDir, `backend_debug${outputSuffix}.log`);
                        if (!fs.existsSync(debugCopy)) {
                            fs.copyFileSync(backendDebugLog, debugCopy);
                        }
                        artifactCandidates.push(debugCopy);
                    }
                    const scriptDebugLog = path.join(actionDir, '..', 'script_debug.log');
                    if (fs.existsSync(scriptDebugLog)) {
                        const debugCopy = path.join(outputDir, `script_debug${outputSuffix}.log`);
                        if (!fs.existsSync(debugCopy)) {
                            fs.copyFileSync(scriptDebugLog, debugCopy);
                        }
                        artifactCandidates.push(debugCopy);
                    }
                }
                const files = existingArtifactPaths(artifactCandidates);
                
                if (files.length > 0) {
                    if (debugMode) {
                        console.log('Uploading artifacts...');
                    }
                    await artifactClient.uploadArtifact(artifactName, files, path.resolve(outputDir));
                    uploadedArtifact = { name: artifactName, files };
                    if (debugMode) {
                        console.log('Successfully uploaded artifacts');
                    }
                } else {
                    if (debugMode) {
                        console.log('No artifacts to upload');
                    }
                }
            } catch (error) {
                console.log(`⚠️  Artifact upload failed: ${error instanceof Error ? error.message : 'unknown error'}`);
            }
        } else {
            if (debugMode) {
                if (!isGitHubActions) {
                    console.log('⚠️  Not in GitHub Actions context, skipping artifact upload');
                } else if (!hasRuntimeToken) {
                    console.log('⚠️  No runtime token available, skipping artifact upload');
                }
            }
        }

        // Add to GitHub Actions summary unless explicitly disabled
        const disableSummaryOutput = process.env.DISABLE_SUMMARY_OUTPUT === 'true';
        const shouldGenerateSummary = !disableSummaryOutput;
        
        if (process.env.GITHUB_STEP_SUMMARY && shouldGenerateSummary) {
            const summary = fs.readFileSync(process.env.GITHUB_STEP_SUMMARY, 'utf8');

            if (backendMode && runId) {
                // Remote monitoring mode - show dashboard info + Mermaid diagram if data available
                const frontendUrl = `https://process-watcher.web.app/runs/${runId}`;
                const summarySubtitle = process.env.GITHUB_JOB || runId || '';
                
                let newSummary = `${summary}

## Build Process Watcher${summarySubtitle ? ` (${summarySubtitle})` : ''}

### Remote Monitoring Mode
- **Dashboard URL**: ${frontendUrl} (**Data Retention**: 24 hours)
`;

                // Add Mermaid diagram if we have local data
                if (fs.existsSync(logFile) && processes.size > 0) {
                    const maxRss = Math.max(...Array.from(processes.values()).flatMap(p => p.rss));
                    const processCount = processes.size;
                    const duration = timestamps.length > 0 ?
                        `from ${timestamps[0]} to ${timestamps[timestamps.length - 1]}` :
                        'N/A';

                    newSummary += `

### Build Process Graph
\`\`\`mermaid
${mermaidChart}
\`\`\`

### Overview
- Number of processes monitored: ${processCount}
- Maximum RSS observed: ${maxRss.toFixed(2)} MB
- Monitoring duration: ${duration}

### Process Details
${Array.from(processes.entries()).map(([key, data]) => {
    const maxProcessRss = Math.max(...data.rss);
    const avgProcessRss = data.rss.reduce((a, b) => a + b, 0) / data.rss.length;
    const lastRss = data.rss[data.rss.length - 1];
    const jitStats = hasJitData && data.jitCompiledMethods.some(value => value !== null)
        ? `\n- Last JIT compiled methods: ${lastNonNull(data.jitCompiledMethods) ?? 'N/A'}`
        : '';
    const classStats = hasClassData && data.classesLoaded.some(value => value !== null)
        ? `\n- Last classes loaded: ${lastNonNull(data.classesLoaded) ?? 'N/A'}`
        : '';
    return `#### ${key}
- Maximum RSS: ${maxProcessRss.toFixed(2)} MB
- Average RSS: ${avgProcessRss.toFixed(2)} MB
- Number of measurements: ${data.rss.length}
- Last measurement: ${lastRss.toFixed(2)} MB${jitStats}${classStats}`;
}).join('\n\n')}

                > Note: Detailed SVG graphs and the log file are available in the artifacts of this workflow run.`;
                }

                fs.writeFileSync(process.env.GITHUB_STEP_SUMMARY, newSummary);
            } else if (fs.existsSync(logFile)) {
                // Local monitoring mode - show analysis
                const maxRss = Math.max(...Array.from(processes.values()).flatMap(p => p.rss));
                const processCount = processes.size;
                const duration = timestamps.length > 0 ?
                    `from ${timestamps[0]} to ${timestamps[timestamps.length - 1]}` :
                    'N/A';
                const summarySubtitle = process.env.GITHUB_JOB || runId || '';

                const artifactStatus = uploadedArtifact
                    ? artifactSummary(uploadedArtifact.name, uploadedArtifact.files)
                    : '> ⚠️ Result artifacts were not archived by Build Process Watcher.';

                const newSummary = `${summary}

## Build Process Watcher${summarySubtitle ? ` (${summarySubtitle})` : ''}

### Build Process Graph
\`\`\`mermaid
${mermaidChart}
\`\`\`

### Overview
- Number of processes monitored: ${processCount}
- Maximum RSS observed: ${maxRss.toFixed(2)} MB
- Monitoring duration: ${duration}

### Process Details
${Array.from(processes.entries()).map(([key, data]) => {
    const maxProcessRss = Math.max(...data.rss);
    const avgProcessRss = data.rss.reduce((a, b) => a + b, 0) / data.rss.length;
    const lastRss = data.rss[data.rss.length - 1];
    const gcStats = hasGcData && data.gcTime && data.gcTime.length > 0
        ? (() => {
            const maxGc = Math.max(...data.gcTime);
            const lastGc = data.gcTime[data.gcTime.length - 1];
            return `\n- Max GC time: ${maxGc.toFixed(3)} s\n- Last GC time: ${lastGc.toFixed(3)} s`;
        })()
        : '';
    const jitStats = hasJitData && data.jitCompiledMethods.some(value => value !== null)
        ? `\n- Last JIT compiled methods: ${lastNonNull(data.jitCompiledMethods) ?? 'N/A'}`
        : '';
    const classStats = hasClassData && data.classesLoaded.some(value => value !== null)
        ? `\n- Last classes loaded: ${lastNonNull(data.classesLoaded) ?? 'N/A'}`
        : '';
    return `#### ${key}
- Maximum RSS: ${maxProcessRss.toFixed(2)} MB
- Average RSS: ${avgProcessRss.toFixed(2)} MB
- Number of measurements: ${data.rss.length}
- Last measurement: ${lastRss.toFixed(2)} MB${gcStats}${jitStats}${classStats}`;
}).join('\n\n')}

${artifactStatus}`;

                fs.writeFileSync(process.env.GITHUB_STEP_SUMMARY, newSummary);
            }
        }
    } catch (error) {
        console.error('Error during cleanup:', error);
        process.exit(1);
    } finally {
        if (!isTrapHandler) {
            cleanupWorkspaceLeftovers(resolvedLogFile, debugMode);
        }
        // Always release the lock
        releaseLock();
    }
}

run();
