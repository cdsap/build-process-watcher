import * as fs from 'fs';

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
 * Format: PID\tName\tVM_FLAGS_JSON per line.
 */
export function loadProcessInfoFromFile(logFile: string): Record<string, { name: string; vm_flags: string[] }> {
    const processInfo: Record<string, { name: string; vm_flags: string[] }> = {};
    const processInfoPath = logFile.replace(/\.log$/, '.process_info');
    if (!fs.existsSync(processInfoPath)) return processInfo;
    try {
        const content = fs.readFileSync(processInfoPath, 'utf8');
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const tabIdx = trimmed.indexOf('\t');
            if (tabIdx === -1) continue;
            const pid = trimmed.slice(0, tabIdx).trim();
            const rest = trimmed.slice(tabIdx + 1);
            const secondTabIdx = rest.indexOf('\t');
            if (secondTabIdx === -1) continue;
            const name = rest.slice(0, secondTabIdx).trim();
            const vmFlagsJson = rest.slice(secondTabIdx + 1).trim();
            let vm_flags: string[] = [];
            try {
                vm_flags = JSON.parse(vmFlagsJson);
                if (!Array.isArray(vm_flags)) vm_flags = [];
            } catch {
                // ignore parse errors
            }
            if (pid && name) {
                processInfo[pid] = { name, vm_flags };
            }
        }
    } catch {
        // ignore read errors
    }
    return processInfo;
}

/**
 * Generate JSON report from log file, merging vm_flags from process_info when available.
 */
export function generateJsonReport(logFile: string, outputFile: string, hasGcData: boolean): void {
    const lines = fs.readFileSync(logFile, 'utf8').split('\n');
    const dataLines = lines.slice(2).filter(line => line.trim().length > 0);
    const samples: Array<{
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
    const processInfoFromFile = loadProcessInfoFromFile(logFile);
    const processInfo: Record<string, { name: string; vm_flags: string[] }> = {};

    dataLines.forEach(line => {
        const parts = line.trim().split('|').map(p => p.trim());
        if (parts.length !== 6 && parts.length !== 7 && parts.length !== 14) return;
        const [timestamp, pid, name, heapUsed, heapCap, rss, gcTime, jitCompiled, jitFailed, jitInvalid, jitTime, classesLoaded, classesUnloaded, classTime] = parts;
        const elapsedSeconds = parseTimestampSeconds(timestamp);
        const rssValue = parseFloat(rss.replace('MB', ''));
        const heapUsedValue = parseFloat(heapUsed.replace('MB', ''));
        const heapCapValue = parseFloat(heapCap.replace('MB', ''));
        const gcSeconds = parts.length >= 7 && hasGcData
            ? parseFloat(gcTime.replace('s', ''))
            : NaN;
        const gcSecondsValue = Number.isNaN(gcSeconds) ? null : gcSeconds;
        const optionalNumber = (value: string | undefined): number | null => {
            if (!value || value === 'N/A') return null;
            const parsed = Number(value.replace(/s$/, ''));
            return Number.isFinite(parsed) ? parsed : null;
        };
        const optionalMillis = (value: string | undefined): number | null => {
            const seconds = optionalNumber(value);
            return seconds === null ? null : seconds * 1000;
        };

        samples.push({
            Timestamp: Math.max(0, elapsedSeconds * 1000),
            ElapsedTime: Math.max(0, elapsedSeconds),
            PID: pid,
            Name: name,
            RSS: Number.isNaN(rssValue) ? 0 : rssValue,
            HeapUsed: Number.isNaN(heapUsedValue) ? 0 : heapUsedValue,
            HeapCap: Number.isNaN(heapCapValue) ? 0 : heapCapValue,
            GCTime: gcSecondsValue !== null ? gcSecondsValue * 1000 : null,
            GCTimeSeconds: gcSecondsValue,
            JITCompiledMethods: optionalNumber(jitCompiled),
            JITFailedCompilations: optionalNumber(jitFailed),
            JITInvalidatedCompilations: optionalNumber(jitInvalid),
            JITCompilationTimeMs: optionalMillis(jitTime),
            ClassesLoaded: optionalNumber(classesLoaded),
            ClassesUnloaded: optionalNumber(classesUnloaded),
            ClassLoadTimeMs: optionalMillis(classTime)
        });

        if (!processInfo[pid]) {
            const fromFile = processInfoFromFile[pid];
            processInfo[pid] = {
                name,
                vm_flags: fromFile?.vm_flags ?? []
            };
        }
    });

    const payload = {
        samples,
        process_info: processInfo,
        finished: true
    };

    fs.writeFileSync(outputFile, JSON.stringify(payload, null, 2));
}
