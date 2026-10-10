export type LogSampleColumnCount = 6 | 7 | 14;

export interface LogSample {
    timestamp: string;
    pid: string;
    name: string;
    heapUsedMb: number;
    heapCapMb: number;
    rssMb: number;
    columnCount: LogSampleColumnCount;
    gcTimeSeconds: number | null;
    jitCompiledMethods: number | null;
    jitFailedCompilations: number | null;
    jitInvalidatedCompilations: number | null;
    jitCompilationTimeSeconds: number | null;
    classesLoaded: number | null;
    classesUnloaded: number | null;
    classLoadTimeSeconds: number | null;
    /** Original cells retained for callers that serialize the legacy format. */
    raw: {
        heapUsedMb: string;
        heapCapMb: string;
        rssMb: string;
        gcTime: string | undefined;
        optionalMetrics: readonly string[];
    };
}

export function parseLogSample(line: string): LogSample | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    const parts = trimmed.split('|').map(part => part.trim());
    if (parts.length !== 6 && parts.length !== 7 && parts.length !== 14) {
        return null;
    }

    const columnCount = parts.length as LogSampleColumnCount;
    const [timestamp, pid, name, heapUsed, heapCap, rss, gcTime, ...optionalMetrics] = parts;
    const [
        jitCompiled,
        jitFailed,
        jitInvalid,
        jitTime,
        classesLoaded,
        classesUnloaded,
        classTime,
    ] = optionalMetrics;

    return {
        timestamp,
        pid,
        name,
        heapUsedMb: parseFloat(heapUsed.replace('MB', '')),
        heapCapMb: parseFloat(heapCap.replace('MB', '')),
        rssMb: parseFloat(rss.replace('MB', '')),
        columnCount,
        gcTimeSeconds: columnCount >= 7 ? parseGcTimeSeconds(gcTime) : null,
        jitCompiledMethods: parseOptionalMetric(jitCompiled),
        jitFailedCompilations: parseOptionalMetric(jitFailed),
        jitInvalidatedCompilations: parseOptionalMetric(jitInvalid),
        jitCompilationTimeSeconds: parseOptionalMetric(jitTime),
        classesLoaded: parseOptionalMetric(classesLoaded),
        classesUnloaded: parseOptionalMetric(classesUnloaded),
        classLoadTimeSeconds: parseOptionalMetric(classTime),
        raw: {
            heapUsedMb: heapUsed,
            heapCapMb: heapCap,
            rssMb: rss,
            gcTime: columnCount >= 7 ? gcTime : undefined,
            optionalMetrics: columnCount === 14 ? optionalMetrics : [],
        },
    };
}

export function parseLogSamples(logText: string): LogSample[] {
    const samples: LogSample[] = [];
    for (const line of logText.split('\n').slice(2)) {
        const sample = parseLogSample(line);
        if (sample) samples.push(sample);
    }
    return samples;
}

function parseGcTimeSeconds(value: string | undefined): number | null {
    if (!value) return null;
    const parsed = parseFloat(value.replace('s', ''));
    return Number.isNaN(parsed) ? null : parsed;
}

export function parseOptionalMetric(value: string | undefined): number | null {
    if (!value || value === 'N/A') return null;
    const parsed = Number(value.replace(/s$/, ''));
    return Number.isFinite(parsed) ? parsed : null;
}
