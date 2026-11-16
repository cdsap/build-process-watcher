import { parseTimestampSeconds } from './report';
import { MermaidProcessData } from './mermaid';

export type ProcessData = MermaidProcessData;

export function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
        return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
}

export function buildForwardFilledSeries(
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

export function buildPathFromSeries(
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

export function lightenHexColor(hex: string, amount: number): string {
    const normalized = hex.replace('#', '');
    if (normalized.length !== 6) return hex;
    const num = parseInt(normalized, 16);
    const r = Math.min(255, ((num >> 16) & 0xff) + amount);
    const g = Math.min(255, ((num >> 8) & 0xff) + amount);
    const b = Math.min(255, (num & 0xff) + amount);
    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

export function escapeSvgText(value: string): string {
    return value.replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&apos;'
    }[char] || char));
}

export function lastNonNull(values: Array<number | null>): number | null {
    for (let i = values.length - 1; i >= 0; i -= 1) {
        if (values[i] !== null) {
            return values[i];
        }
    }
    return null;
}

export function generateMetricSvg(
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

export function generateSvg(processes: Map<string, ProcessData>, timestamps: string[]): string {
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

export function generateGcSvg(processes: Map<string, ProcessData>, timestamps: string[]): string {
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

