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

export function lastNonNull(values: Array<number | null>): number | null {
    for (let i = values.length - 1; i >= 0; i -= 1) {
        if (values[i] !== null) {
            return values[i];
        }
    }
    return null;
}
