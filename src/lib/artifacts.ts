import * as fs from 'fs';
import * as path from 'path';

export function existingArtifactPaths(candidates: string[]): string[] {
    return candidates
        .map(candidate => path.resolve(candidate))
        .filter(candidate => fs.existsSync(candidate));
}

export function artifactSummary(name: string, files: string[]): string {
    const charts = files
        .filter(file => path.extname(file) === '.svg')
        .map(file => `\`${path.basename(file)}\``);
    const chartDetails = charts.length > 0 ? ` Charts: ${charts.join(', ')}.` : '';

    return `> Archived ${files.length} result files in artifact \`${name}\`.${chartDetails}`;
}
