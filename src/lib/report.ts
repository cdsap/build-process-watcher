import * as fs from 'fs';
import { parseLogSamples, MetricMeasurements, MetricRecord } from './log_samples';
import { parseProcessInfo } from './process_info';

export { parseProcessInfo } from './process_info';

const SAMPLE_FIELDS = [
    'Timestamp', 'ElapsedTime', 'PID', 'Name', 'RSS', 'HeapUsed', 'HeapCap',
    'GCTime', 'GCTimeSeconds', 'JITCompiledMethods', 'JITFailedCompilations',
    'JITInvalidatedCompilations', 'JITCompilationTimeMs', 'ClassesLoaded',
    'ClassesUnloaded', 'ClassLoadTimeMs'
] as const;

/**
 * Parse timestamp string (HH:MM:SS or seconds number) to seconds.
 */
export function parseTimestampSeconds(timestamp: string): number {
    if (timestamp.includes(':')) {
        const parts = timestamp.split(':').map(part => parseInt(part, 10));
        if (parts.length === 3 && parts.every(Number.isFinite)) {
            return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
        }
    }
    const numeric = parseFloat(timestamp);
    return Number.isFinite(numeric) ? numeric : 0;
}

/**
 * Load process info (including vm_flags) from .process_info file.
 */
export function loadProcessInfoFromFile(logFile: string): Record<string, { name: string; vm_flags: string[] }> {
    const processInfoPath = logFile.replace(/\.log$/, '.process_info');
    if (!fs.existsSync(processInfoPath)) return {};
    try {
        return parseProcessInfo(fs.readFileSync(processInfoPath, 'utf8'));
    } catch {
        // ignore read errors
    }
    return {};
}

/**
 * Build JSON report payload, merging supplied process metadata when available.
 */
export function buildJsonReport(
    logText: string,
    processInfo: Record<string, { name: string; vm_flags: string[] }>,
    hasGcData: boolean,
    metricRecords?: MetricRecord[]
) {
    const samples: Array<{
        MetricMeasurements?: MetricMeasurements;
        Timestamp: number;
        ElapsedTime: number;
        PID: string;
        Name: string;
        RSS: number;
        HeapUsed: number;
        HeapCap: number;
        GCTime: number | null;
        GCTimeSeconds: number | null;
        JITCompiledMethods: number | null;
        JITFailedCompilations: number | null;
        JITInvalidatedCompilations: number | null;
        JITCompilationTimeMs: number | null;
        ClassesLoaded: number | null;
        ClassesUnloaded: number | null;
        ClassLoadTimeMs: number | null;
    }> = [];
    const mergedProcessInfo: Record<string, { name: string; vm_flags: string[] }> = {};

    const byLine = new Map<string, MetricMeasurements[]>();
    const key = (line: string) => line.split('|').map(cell => cell.trim()).join('|');
    for (const record of metricRecords ?? []) {
        const values = byLine.get(key(record.data)) ?? [];
        values.push(record.metric_measurements);
        byLine.set(key(record.data), values);
    }
    parseLogSamples(logText).forEach(row => {
        const elapsedSeconds = parseTimestampSeconds(row.timestamp);
        const gcSecondsValue = hasGcData ? row.gcTimeSeconds : null;

        const line = [row.timestamp, row.pid, row.name, row.raw.heapUsedMb, row.raw.heapCapMb, row.raw.rssMb,
            ...(row.columnCount >= 7 ? [row.raw.gcTime] : []), ...row.raw.optionalMetrics].join('|');
        samples.push({
            ...(metricRecords ? { MetricMeasurements: byLine.get(key(line))?.shift() ?? {} } : {}),
            Timestamp: Math.max(0, elapsedSeconds * 1000),
            ElapsedTime: Math.max(0, elapsedSeconds),
            PID: row.pid,
            Name: row.name,
            RSS: Number.isNaN(row.rssMb) ? 0 : row.rssMb,
            HeapUsed: Number.isNaN(row.heapUsedMb) ? 0 : row.heapUsedMb,
            HeapCap: Number.isNaN(row.heapCapMb) ? 0 : row.heapCapMb,
            GCTime: gcSecondsValue !== null ? gcSecondsValue * 1000 : null,
            GCTimeSeconds: gcSecondsValue,
            JITCompiledMethods: row.jitCompiledMethods,
            JITFailedCompilations: row.jitFailedCompilations,
            JITInvalidatedCompilations: row.jitInvalidatedCompilations,
            JITCompilationTimeMs: row.jitCompilationTimeSeconds !== null ? row.jitCompilationTimeSeconds * 1000 : null,
            ClassesLoaded: row.classesLoaded,
            ClassesUnloaded: row.classesUnloaded,
            ClassLoadTimeMs: row.classLoadTimeSeconds !== null ? row.classLoadTimeSeconds * 1000 : null
        });

        if (!mergedProcessInfo[row.pid]) {
            const fromFile = processInfo[row.pid];
            mergedProcessInfo[row.pid] = {
                name: row.name,
                vm_flags: fromFile?.vm_flags ?? []
            };
        }
    });

    const fields = metricRecords ? [...SAMPLE_FIELDS, 'MetricMeasurements' as const] : SAMPLE_FIELDS;
    return {
        sample_fields: fields,
        samples: samples.map(sample => fields.map(field => sample[field])),
        process_info: mergedProcessInfo,
        finished: true
    };
}

/**
 * Generate JSON report from log file, merging vm_flags from process_info when available.
 */
export function generateJsonReport(logFile: string, outputFile: string, hasGcData: boolean): void {
    const processInfo = loadProcessInfoFromFile(logFile);
    const timingsFile = logFile + '.measurements.jsonl';
    const records: MetricRecord[] | undefined = fs.existsSync(timingsFile) ? [] : undefined;
    if (records) {
        for (const line of fs.readFileSync(timingsFile, 'utf8').split('\n').filter(Boolean)) {
            try {
                const record = JSON.parse(line) as MetricRecord;
                if (typeof record.data === 'string' && record.metric_measurements && typeof record.metric_measurements === 'object') records.push(record);
            } catch { console.warn('Ignoring an incomplete metric measurement record'); }
        }
    }
    const payload = buildJsonReport(fs.readFileSync(logFile, 'utf8'), processInfo, hasGcData, records);
    fs.writeFileSync(outputFile, JSON.stringify(payload, null, 2));
}

export function generateCsvReport(logFile: string, outputFile: string, hasGcData: boolean): void {
    const header = ['elapsed_time', 'pid', 'name', 'heap_used_mb', 'heap_capacity_mb', 'rss_mb', 'gc_time_s', 'jit_compiled_methods', 'jit_failed_compilations', 'jit_invalidated_compilations', 'jit_compilation_time_s', 'classes_loaded', 'classes_unloaded', 'class_load_time_s'];
    const rows = [header.join(',')];

    parseLogSamples(fs.readFileSync(logFile, 'utf8')).forEach(row => {
        const baseRow = [
            row.timestamp,
            row.pid,
            row.name,
            row.raw.heapUsedMb,
            row.raw.heapCapMb,
            row.raw.rssMb
        ];
        baseRow.push(row.columnCount < 7 || !hasGcData
            ? ''
            : (row.raw.gcTime ?? '').replace('s', '').replace('N/A', ''));
        baseRow.push(...Array.from({ length: 7 }, (_, index) =>
            (row.raw.optionalMetrics[index] ?? '').replace('N/A', '')));
        rows.push(baseRow.join(','));
    });

    fs.writeFileSync(outputFile, rows.join('\n'));
}

