export type MonitorLogColumnCount = 6 | 7 | 14;

export interface MonitorLogRow {
    timestamp: string;
    pid: string;
    name: string;
    /** Memory values with the MB suffix removed. */
    heapUsedMb: string;
    heapCapMb: string;
    rssMb: string;
    columnCount: MonitorLogColumnCount;
    /** Present when the row includes a GC column (7 or 14 columns). */
    gcTimeRaw: string | undefined;
    /** Extended JVM metric cells for 14-column rows; otherwise empty. */
    optionalMetricRaws: readonly string[];
}

/**
 * Parse a single pipe-delimited monitor log line into a normalized row.
 * Accepts legacy 6/7-column records and extended 14-column JVM metric records.
 */
export function parseMonitorLogLine(line: string): MonitorLogRow | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    const parts = trimmed.split('|').map(part => part.trim());
    if (parts.length !== 6 && parts.length !== 7 && parts.length !== 14) {
        return null;
    }

    const columnCount = parts.length as MonitorLogColumnCount;
    const [timestamp, pid, name, heapUsed, heapCap, rss, gcTime, ...optionalMetrics] = parts;

    return {
        timestamp,
        pid,
        name,
        heapUsedMb: heapUsed.replace('MB', ''),
        heapCapMb: heapCap.replace('MB', ''),
        rssMb: rss.replace('MB', ''),
        columnCount,
        gcTimeRaw: columnCount >= 7 ? gcTime : undefined,
        optionalMetricRaws: columnCount === 14 ? optionalMetrics : []
    };
}

/**
 * Parse raw monitor log text into typed normalized rows.
 * Skips the two header lines and any malformed data rows.
 */
export function parseMonitorLogText(logText: string): MonitorLogRow[] {
    const rows: MonitorLogRow[] = [];
    for (const line of logText.split('\n').slice(2)) {
        const row = parseMonitorLogLine(line);
        if (row) {
            rows.push(row);
        }
    }
    return rows;
}

/**
 * Parse optional JVM metric cells (N/A, missing, or non-finite -> null).
 * Strips a trailing `s` suffix used by some time fields.
 */
export function parseOptionalMetric(value: string | undefined): number | null {
    if (!value || value === 'N/A') return null;
    const parsed = Number(value.replace(/s$/, ''));
    return Number.isFinite(parsed) ? parsed : null;
}
