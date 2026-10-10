/** Compatibility exports for the former module name. */
export {
    parseOptionalMetric,
} from './log_samples';

import { LogSample, parseLogSample, parseLogSamples } from './log_samples';

export type MonitorLogColumnCount = 6 | 7 | 14;
export interface MonitorLogRow {
    timestamp: string;
    pid: string;
    name: string;
    heapUsedMb: string;
    heapCapMb: string;
    rssMb: string;
    columnCount: MonitorLogColumnCount;
    gcTimeRaw: string | undefined;
    optionalMetricRaws: readonly string[];
    gcTimeSeconds: number | null;
    jitCompiledMethods: number | null;
    jitFailedCompilations: number | null;
    jitInvalidatedCompilations: number | null;
    jitCompilationTimeSeconds: number | null;
    classesLoaded: number | null;
    classesUnloaded: number | null;
    classLoadTimeSeconds: number | null;
}

function toMonitorLogRow(sample: LogSample): MonitorLogRow {
    return {
        timestamp: sample.timestamp,
        pid: sample.pid,
        name: sample.name,
        heapUsedMb: sample.raw.heapUsedMb.replace('MB', ''),
        heapCapMb: sample.raw.heapCapMb.replace('MB', ''),
        rssMb: sample.raw.rssMb.replace('MB', ''),
        columnCount: sample.columnCount,
        gcTimeRaw: sample.raw.gcTime,
        optionalMetricRaws: sample.raw.optionalMetrics,
        gcTimeSeconds: sample.gcTimeSeconds,
        jitCompiledMethods: sample.jitCompiledMethods,
        jitFailedCompilations: sample.jitFailedCompilations,
        jitInvalidatedCompilations: sample.jitInvalidatedCompilations,
        jitCompilationTimeSeconds: sample.jitCompilationTimeSeconds,
        classesLoaded: sample.classesLoaded,
        classesUnloaded: sample.classesUnloaded,
        classLoadTimeSeconds: sample.classLoadTimeSeconds,
    };
}

export function parseMonitorLogLine(line: string): MonitorLogRow | null {
    const sample = parseLogSample(line);
    return sample ? toMonitorLogRow(sample) : null;
}

export function parseMonitorLogText(logText: string): MonitorLogRow[] {
    return parseLogSamples(logText).map(toMonitorLogRow);
}

export function monitorLogCsvGcTime(row: MonitorLogRow, hasGcData: boolean): string {
    if (row.columnCount < 7 || !hasGcData) return '';
    return (row.gcTimeRaw ?? '').replace('s', '').replace('N/A', '');
}

export function monitorLogCsvOptionalMetricFields(row: MonitorLogRow): string[] {
    return Array.from({ length: 7 }, (_, index) =>
        (row.optionalMetricRaws[index] ?? '').replace('N/A', '')
    );
}
