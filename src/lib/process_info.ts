/**
 * Parse process info (including vm_flags) from text.
 * Format: PID\tName\tVM_FLAGS_JSON per line.
 */
export function parseProcessInfo(content: string): Record<string, { name: string; vm_flags: string[] }> {
    const processInfo: Record<string, { name: string; vm_flags: string[] }> = {};
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
    return processInfo;
}
