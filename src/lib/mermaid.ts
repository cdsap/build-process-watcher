export interface MermaidProcessData {
    timestamps: string[];
    rss: number[];
    heapUsed: number[];
    heapCap: number[];
    gcTime?: number[];
    gcAvailable?: boolean[];
    jitCompiledMethods: Array<number | null>;
    jitFailedCompilations: Array<number | null>;
    classesLoaded: Array<number | null>;
    classesUnloaded: Array<number | null>;
}

const MAX_CHECKPOINTS = 6;

function escapeLabel(value: string): string {
    return value.replace(/[&<>\"]/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;'
    }[character] || character));
}

function selectRepresentativeTimestamps(timestamps: string[]): string[] {
    if (timestamps.length <= MAX_CHECKPOINTS) return timestamps;

    return Array.from({ length: MAX_CHECKPOINTS }, (_, index) => {
        const sourceIndex = Math.round(index * (timestamps.length - 1) / (MAX_CHECKPOINTS - 1));
        return timestamps[sourceIndex];
    });
}

function finiteValue(values: Array<number | null> | undefined, index: number): number | null {
    const value = values?.[index];
    return value !== null && value !== undefined && Number.isFinite(value) ? value : null;
}

function gcValue(data: MermaidProcessData, index: number): number | null {
    if (data.gcAvailable?.[index] === false) return null;
    return finiteValue(data.gcTime, index);
}

function processNodeLabel(key: string, data: MermaidProcessData, index: number): string {
    const lines = [
        escapeLabel(key),
        `RSS ${data.rss[index].toFixed(0)}MB`,
        `Heap ${data.heapUsed[index].toFixed(0)}/${data.heapCap[index].toFixed(0)}MB`
    ];
    const gcTime = gcValue(data, index);
    const jitCompiled = finiteValue(data.jitCompiledMethods, index);
    const jitFailed = finiteValue(data.jitFailedCompilations, index);
    const classesLoaded = finiteValue(data.classesLoaded, index);
    const classesUnloaded = finiteValue(data.classesUnloaded, index);

    if (gcTime !== null) lines.push(`GC ${gcTime.toFixed(3)}s`);
    if (jitCompiled !== null) {
        lines.push(`JIT ${jitCompiled.toFixed(0)} compiled${jitFailed !== null ? ` / ${jitFailed.toFixed(0)} failed` : ''}`);
    }
    if (classesLoaded !== null) {
        lines.push(`Classes ${classesLoaded.toFixed(0)} loaded${classesUnloaded !== null ? ` / ${classesUnloaded.toFixed(0)} unloaded` : ''}`);
    }

    return lines.join('<br/>');
}

export function generateCombinedMermaidChart(
    processes: Map<string, MermaidProcessData>,
    timestamps: string[]
): string {
    const sampledTimestamps = selectRepresentativeTimestamps(timestamps);
    const aggregates = sampledTimestamps.map(timestamp => {
        let rss = 0;
        let gcTime = 0;
        let hasGcTime = false;

        for (const data of processes.values()) {
            const index = data.timestamps.indexOf(timestamp);
            if (index === -1) continue;
            rss += data.rss[index];
            const processGcTime = gcValue(data, index);
            if (processGcTime !== null) {
                gcTime += processGcTime;
                hasGcTime = true;
            }
        }
        return { rss, gcTime: hasGcTime ? gcTime : null };
    });

    const processNodeIds = Array.from(processes.entries()).flatMap(([key, data]) => {
        const cleanKey = key.replace(/[^a-zA-Z0-9]/g, '_');
        return sampledTimestamps.flatMap((timestamp, index) =>
            data.timestamps.includes(timestamp) ? [`${cleanKey}_${index}`] : []
        );
    });

    return `%%{init: {'theme': 'dark'}}%%
flowchart LR
    subgraph Time[" "]
        direction TB
        ${sampledTimestamps.map((timestamp, checkpointIndex) => {
            const processNodes = Array.from(processes.entries()).map(([key, data]) => {
                const dataIndex = data.timestamps.indexOf(timestamp);
                if (dataIndex === -1) return '';
                const cleanKey = key.replace(/[^a-zA-Z0-9]/g, '_');
                return `        ${cleanKey}_${checkpointIndex}["${processNodeLabel(key, data, dataIndex)}"]`;
            }).filter(Boolean).join('\n        ');
            const aggregate = aggregates[checkpointIndex];
            const aggregateGc = aggregate.gcTime !== null ? `<br/>GC ${aggregate.gcTime.toFixed(3)}s` : '';
            return `    subgraph T${checkpointIndex}["${timestamp}"]
            ${processNodes}
            Agg_${checkpointIndex}["Aggregated<br/>RSS ${aggregate.rss.toFixed(0)}MB${aggregateGc}"]
        end`;
        }).join('\n        ')}
    end

    ${Array.from(processes.entries()).map(([key, data]) => {
        const cleanKey = key.replace(/[^a-zA-Z0-9]/g, '_');
        return sampledTimestamps.map((timestamp, checkpointIndex) => {
            if (checkpointIndex === 0) return '';
            const previousIndex = data.timestamps.indexOf(sampledTimestamps[checkpointIndex - 1]);
            const currentIndex = data.timestamps.indexOf(timestamp);
            if (previousIndex === -1 || currentIndex === -1) return '';
            return `    ${cleanKey}_${checkpointIndex - 1} --> ${cleanKey}_${checkpointIndex}`;
        }).filter(Boolean).join('\n    ');
    }).join('\n    ')}

    ${sampledTimestamps.map((_, checkpointIndex) => checkpointIndex === 0
        ? ''
        : `    Agg_${checkpointIndex - 1} --> Agg_${checkpointIndex}`
    ).filter(Boolean).join('\n    ')}

    classDef process fill:#1D4ED8,stroke:#93C5FD,color:#FFFFFF,stroke-width:2px
    classDef aggregated fill:#FF6B6B,stroke:#333,stroke-width:2px
    ${processNodeIds.length > 0 ? `class ${processNodeIds.join(',')} process` : ''}
    ${sampledTimestamps.length > 0 ? `class ${sampledTimestamps.map((_, index) => `Agg_${index}`).join(',')} aggregated` : ''}`;
}
