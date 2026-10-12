import { parseTimestampSeconds } from './report';
import { parseLogSamples } from './log_samples';
import { MermaidProcessData } from './mermaid';

export type LogParseResult = {
    processes: Map<string, MermaidProcessData>;
    timestamps: string[];
    hasGcData: boolean;
    hasJitData: boolean;
    hasClassData: boolean;
};

export function parseLogContents(contents: string): LogParseResult {
    const processes = new Map<string, MermaidProcessData>();
    const timestamps = new Set<string>();
    let hasGcData = false;
    let hasJitData = false;
    let hasClassData = false;

    parseLogSamples(contents).forEach(row => {
        const processKey = `${row.pid}-${row.name}`;

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
                classesUnloaded: [],
            });
        }

        const processData = processes.get(processKey)!;
        processData.timestamps.push(row.timestamp);
        processData.rss.push(row.rssMb);
        timestamps.add(row.timestamp);
        processData.heapUsed.push(row.heapUsedMb);
        processData.heapCap.push(row.heapCapMb);

        processData.jitCompiledMethods.push(row.jitCompiledMethods);
        processData.jitFailedCompilations.push(row.jitFailedCompilations);
        processData.classesLoaded.push(row.classesLoaded);
        processData.classesUnloaded.push(row.classesUnloaded);
        if (row.jitCompiledMethods !== null) {
            hasJitData = true;
        }
        if (row.classesLoaded !== null) {
            hasClassData = true;
        }

        if (row.gcTimeSeconds !== null) {
            hasGcData = true;
            processData.gcTime!.push(row.gcTimeSeconds);
            processData.gcAvailable!.push(true);
        } else if (processData.gcTime) {
            processData.gcTime.push(0);
            processData.gcAvailable!.push(false);
        }
    });

    const orderedTimestamps = Array.from(timestamps)
        .sort((a, b) => parseTimestampSeconds(a) - parseTimestampSeconds(b));
    return { processes, timestamps: orderedTimestamps, hasGcData, hasJitData, hasClassData };
}
