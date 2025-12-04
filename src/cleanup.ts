import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { DefaultArtifactClient } from '@actions/artifact';
import * as core from '@actions/core';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const execAsync = promisify(exec);

interface ProcessData {
    timestamps: string[];
    rss: number[];
    heapUsed: number[];
    heapCap: number[];
    gcTime?: number[]; // GC time in seconds, optional
}

function parseLogFile(logFile: string): { processes: Map<string, ProcessData>, timestamps: string[], hasGcData: boolean } {
    const processes = new Map<string, ProcessData>();
    const timestamps = new Set<string>();
    let hasGcData = false;

    const lines = fs.readFileSync(logFile, 'utf8').split('\n');
    // Skip header lines
    lines.slice(2).forEach(line => {
        const parts = line.trim().split('|').map(p => p.trim());
        // Support both 6 columns (without GC) and 7 columns (with GC)
        if (parts.length !== 6 && parts.length !== 7) return;

        const [timestamp, pid, name, heapUsed, heapCap, rss, gcTime] = parts;
        const rssValue = parseFloat(rss.replace('MB', ''));
        const heapUsedValue = parseFloat(heapUsed.replace('MB', ''));
        const heapCapValue = parseFloat(heapCap.replace('MB', ''));
        const processKey = `${pid}-${name}`;

        if (!processes.has(processKey)) {
            processes.set(processKey, { timestamps: [], rss: [], heapUsed: [], heapCap: [], gcTime: [] });
        }

        const processData = processes.get(processKey)!;
        processData.timestamps.push(timestamp);
        processData.rss.push(rssValue);
        timestamps.add(timestamp);
        processData.heapUsed.push(heapUsedValue);
        processData.heapCap.push(heapCapValue);
        
        // Parse GC time if available (7th column)
        if (parts.length === 7 && gcTime) {
            hasGcData = true;
            // Remove 's' suffix if present and parse as float
            const gcTimeValue = parseFloat(gcTime.replace('s', ''));
            if (!isNaN(gcTimeValue)) {
                processData.gcTime!.push(gcTimeValue);
            } else {
                processData.gcTime!.push(0);
            }
        } else if (processData.gcTime) {
            // If GC data was expected but missing, push 0
            processData.gcTime.push(0);
        }
        });

    return { processes, timestamps: Array.from(timestamps).sort(), hasGcData };
}

function generateMermaidChart(processes: Map<string, ProcessData>, timestamps: string[]): string {
    // Sample points based on data length:
    // - For short logs (< 30 points): show all points
    // - For medium logs (30-100 points): show ~20 points
    // - For long logs (> 100 points): show ~30 points
    const targetPoints = timestamps.length < 30 ? timestamps.length : 
                        timestamps.length < 100 ? 20 : 30;
    const interval = Math.ceil(timestamps.length / targetPoints);
    const sampledTimestamps = timestamps.filter((_, i) => i % interval === 0);
    
    // Calculate aggregated RSS for each timestamp
    const aggregatedRss = sampledTimestamps.map(timestamp => {
        return Array.from(processes.values())
            .filter(p => p.timestamps.includes(timestamp))
            .reduce((sum, p) => sum + p.rss[p.timestamps.indexOf(timestamp)], 0);
    });
    
    return `%%{init: {'theme': 'dark'}}%%
flowchart LR
    subgraph Time["Memory Usage Over Time"]
        direction TB
        ${sampledTimestamps.map((timestamp, i) => {
            return `    subgraph T${i}["${timestamp}"]
            ${Array.from(processes.entries()).map(([key, data]) => {
                const idx = data.timestamps.indexOf(timestamp);
                if (idx === -1) return '';
                const rss = data.rss[idx];
                const cleanKey = key.replace(/[^a-zA-Z0-9]/g, '_');
                return `        ${cleanKey}_${i}["${key}<br/>${rss.toFixed(0)}MB"]`;
            }).filter(Boolean).join('\n        ')}
            ${`        Agg_${i}["Aggregated<br/>${aggregatedRss[i].toFixed(0)}MB"]`}
        end`;
        }).join('\n        ')}
    end

    ${Array.from(processes.entries()).map(([key, data]) => {
        const cleanKey = key.replace(/[^a-zA-Z0-9]/g, '_');
        return sampledTimestamps.map((timestamp, i) => {
            if (i === 0) return '';
            const prevIdx = data.timestamps.indexOf(sampledTimestamps[i-1]);
            const currIdx = data.timestamps.indexOf(timestamp);
            if (prevIdx === -1 || currIdx === -1) return '';
            return `    ${cleanKey}_${i-1} --> ${cleanKey}_${i}`;
        }).filter(Boolean).join('\n    ');
    }).join('\n    ')}

    ${sampledTimestamps.map((_, i) => {
        if (i === 0) return '';
        return `    Agg_${i-1} --> Agg_${i}`;
    }).filter(Boolean).join('\n    ')}
    
    classDef process fill:#4ECDC4,stroke:#333,stroke-width:2px
    classDef aggregated fill:#FF6B6B,stroke:#333,stroke-width:2px
    ${Array.from(processes.keys()).map(key => {
        const cleanKey = key.replace(/[^a-zA-Z0-9]/g, '_');
        return `class ${cleanKey} process`;
    }).join('\n    ')}
    ${sampledTimestamps.map((_, i) => `class Agg_${i} aggregated`).join('\n    ')}`;
}

function generateSvg(processes: Map<string, ProcessData>, timestamps: string[]): string {
    const width = 1400;
    const height = 800;
    const margin = {
        top: 60,
        right: 300,
        bottom: 100,
        left: 100
    };

    // Calculate aggregated RSS first to determine true max value
    const aggregatedRss = timestamps.map(timestamp => {
        return Array.from(processes.values())
            .filter(p => p.timestamps.includes(timestamp))
            .reduce((sum, p) => sum + p.rss[p.timestamps.indexOf(timestamp)], 0);
    });

    // Calculate scales using max of individual processes and aggregated
    const maxIndividualRss = Math.max(...Array.from(processes.values()).flatMap(p => p.rss));
    const maxAggregatedRss = Math.max(...aggregatedRss);
    const maxRss = Math.max(maxIndividualRss, maxAggregatedRss);
    
    // Round up maxRss to nearest 1000 for better y-axis scale
    const yAxisMax = Math.ceil(maxRss / 1000) * 1000;
    const xScale = (width - margin.left - margin.right) / (timestamps.length - 1) || 1;
    const yScale = (height - margin.top - margin.bottom) / yAxisMax;

    // Improved color palette for clarity
    const processColors = [
        '#E4572E', // Red-Orange
        '#29335C', // Navy
        '#A8C686', // Green
        '#669BBC', // Blue
        '#F3A712', // Yellow
        '#6A4C93', // Purple
        '#43AA8B', // Teal
        '#B370B0', // Magenta
    ];
    const aggRssColor = '#222'; // Black for Aggregated RSS
    const aggHeapColor = '#1976D2'; // Blue for Aggregated Heap Used

    // Generate SVG content
    let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">\n`;
    svg += `<rect width="100%" height="100%" fill="#fff"/>\n`;
    // Add title
    svg += `<text x="${width/2}" y="40" text-anchor="middle" font-size="24" font-weight="bold">Build Process Memory Usage Over Time</text>\n`;

    // Add grid lines (every 500MB)
    const gridInterval = 500; // MB
    for (let i = 0; i <= yAxisMax; i += gridInterval) {
        const y = height - margin.bottom - (i * yScale);
        svg += `<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="#e0e0e0" stroke-width="1" stroke-dasharray="5,5"/>\n`;
    }

    // Draw axes
    svg += `<line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="#333" stroke-width="2"/>\n`;
    svg += `<line x1="${margin.left}" y1="${height - margin.bottom}" x2="${margin.left}" y2="${margin.top}" stroke="#333" stroke-width="2"/>\n`;

    // Draw Y axis labels (every 500MB)
    for (let i = 0; i <= yAxisMax; i += gridInterval) {
        const y = height - margin.bottom - (i * yScale);
        svg += `<text x="${margin.left - 10}" y="${y + 5}" text-anchor="end" font-size="12" fill="#333">${i}MB</text>\n`;
    }

    // Draw X axis labels (dynamic interval based on timestamp count)
    const labelInterval = Math.ceil(timestamps.length / 15); // Show ~15 labels
    for (let i = 0; i < timestamps.length; i += labelInterval) {
        const x = margin.left + (i * xScale);
        svg += `<text x="${x}" y="${height - margin.bottom + 20}" transform="rotate(45 ${x},${height - margin.bottom + 20})" text-anchor="start" font-size="12" fill="#333">${timestamps[i]}</text>\n`;
    }

    // Draw process lines and legend
    let legendY = margin.top + 30;
    Array.from(processes.entries()).forEach(([key, data], idx) => {
        const color = processColors[idx % processColors.length];
        // RSS line (solid)
        const rssPoints = data.timestamps.map((timestamp, i) => {
            const x = margin.left + (timestamps.indexOf(timestamp) * xScale);
            const y = height - margin.bottom - (data.rss[i] * yScale);
            return `${x},${y}`;
        }).join(' ');
        svg += `<polyline points="${rssPoints}" stroke="${color}" stroke-width="2.5" fill="none" opacity="0.95"/>\n`;

        // Heap Used line (dashed)
        const heapPoints = data.timestamps.map((timestamp, i) => {
            const x = margin.left + (timestamps.indexOf(timestamp) * xScale);
            const y = height - margin.bottom - (data.heapUsed[i] * yScale);
            return `${x},${y}`;
        }).join(' ');
        svg += `<polyline points="${heapPoints}" stroke="${color}" stroke-width="2.5" fill="none" opacity="0.95" stroke-dasharray="8,5"/>\n`;

        // Legend for this process
        svg += `<rect x="${width - margin.right + 40}" y="${legendY - 10}" width="20" height="6" fill="${color}" opacity="0.95"/>\n`;
        svg += `<text x="${width - margin.right + 70}" y="${legendY - 2}" font-size="14" fill="#333">${key} (RSS)</text>\n`;
        svg += `<line x1="${width - margin.right + 40}" y1="${legendY + 13}" x2="${width - margin.right + 60}" y2="${legendY + 13}" stroke="${color}" stroke-width="2.5" stroke-dasharray="8,5"/>\n`;
        svg += `<text x="${width - margin.right + 70}" y="${legendY + 18}" font-size="14" fill="#333">${key} (Heap Used)</text>\n`;
        legendY += 40;
    });

    // Draw aggregated RSS line (black, solid)
    const aggregatedPoints = timestamps.map((timestamp, i) => {
        const x = margin.left + (i * xScale);
        const y = height - margin.bottom - (aggregatedRss[i] * yScale);
        return `${x},${y}`;
    }).join(' ');
    svg += `<polyline points="${aggregatedPoints}" stroke="${aggRssColor}" stroke-width="3.5" fill="none" opacity="0.9"/>\n`;

    // Aggregated legend
    svg += `<rect x="${width - margin.right + 40}" y="${legendY - 10}" width="20" height="20" fill="${aggRssColor}" opacity="0.9"/>\n`;
    svg += `<text x="${width - margin.right + 70}" y="${legendY + 5}" font-size="14" fill="#333">Aggregated RSS</text>\n`;

    // Add axis labels
    svg += `<text x="${width/2}" y="${height - 10}" text-anchor="middle" font-size="16" fill="#333">Time</text>\n`;
    svg += `<text x="${margin.left - 60}" y="${height/2}" text-anchor="middle" transform="rotate(-90 ${margin.left - 60},${height/2})" font-size="16" fill="#333">Memory Usage (MB)</text>\n`;

    svg += '</svg>';
    return svg;
}

function generateGcSvg(processes: Map<string, ProcessData>, timestamps: string[]): string {
    const width = 1400;
    const height = 800;
    const margin = {
        top: 60,
        right: 300,
        bottom: 100,
        left: 100
    };

    // Calculate aggregated GC time
    const aggregatedGcTime = timestamps.map(timestamp => {
        return Array.from(processes.values())
            .filter(p => p.timestamps.includes(timestamp) && p.gcTime)
            .reduce((sum, p) => {
                const idx = p.timestamps.indexOf(timestamp);
                return sum + (p.gcTime?.[idx] || 0);
            }, 0);
    });

    // Calculate max GC time for scaling
    const maxIndividualGc = Math.max(...Array.from(processes.values())
        .filter(p => p.gcTime)
        .flatMap(p => p.gcTime || []));
    const maxAggregatedGc = Math.max(...aggregatedGcTime);
    const maxGc = Math.max(maxIndividualGc, maxAggregatedGc);
    
    // Round up maxGc to nearest 0.5 for better y-axis scale
    const yAxisMax = Math.ceil(maxGc * 2) / 2 || 1;
    const xScale = (width - margin.left - margin.right) / (timestamps.length - 1) || 1;
    const yScale = (height - margin.top - margin.bottom) / yAxisMax;

    // Color palette for GC charts
    const processColors = [
        '#E4572E', // Red-Orange
        '#29335C', // Navy
        '#A8C686', // Green
        '#669BBC', // Blue
        '#F3A712', // Yellow
        '#6A4C93', // Purple
        '#43AA8B', // Teal
        '#B370B0', // Magenta
    ];
    const aggGcColor = '#DC2626'; // Red for Aggregated GC Time

    // Generate SVG content
    let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">\n`;
    svg += `<rect width="100%" height="100%" fill="#fff"/>\n`;
    // Add title
    svg += `<text x="${width/2}" y="40" text-anchor="middle" font-size="24" font-weight="bold">Build Process GC Time Over Time</text>\n`;

    // Add grid lines (every 0.1s)
    const gridInterval = 0.1; // seconds
    for (let i = 0; i <= yAxisMax; i += gridInterval) {
        const y = height - margin.bottom - (i * yScale);
        svg += `<line x1="${margin.left}" y1="${y}" x2="${width - margin.right}" y2="${y}" stroke="#e0e0e0" stroke-width="1" stroke-dasharray="5,5"/>\n`;
    }

    // Draw axes
    svg += `<line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="#333" stroke-width="2"/>\n`;
    svg += `<line x1="${margin.left}" y1="${height - margin.bottom}" x2="${margin.left}" y2="${margin.top}" stroke="#333" stroke-width="2"/>\n`;

    // Draw Y axis labels (every 0.1s)
    for (let i = 0; i <= yAxisMax; i += gridInterval) {
        const y = height - margin.bottom - (i * yScale);
        if (i % 0.5 === 0 || i === 0) { // Show labels every 0.5s
            svg += `<text x="${margin.left - 10}" y="${y + 5}" text-anchor="end" font-size="12" fill="#333">${i.toFixed(1)}s</text>\n`;
        }
    }

    // Draw X axis labels (dynamic interval based on timestamp count)
    const labelInterval = Math.ceil(timestamps.length / 15); // Show ~15 labels
    for (let i = 0; i < timestamps.length; i += labelInterval) {
        const x = margin.left + (i * xScale);
        svg += `<text x="${x}" y="${height - margin.bottom + 20}" transform="rotate(45 ${x},${height - margin.bottom + 20})" text-anchor="start" font-size="12" fill="#333">${timestamps[i]}</text>\n`;
    }

    // Draw process GC time lines and legend
    let legendY = margin.top + 30;
    Array.from(processes.entries()).forEach(([key, data], idx) => {
        if (!data.gcTime || data.gcTime.length === 0) return;
        
        const color = processColors[idx % processColors.length];
        // GC time line (solid)
        const gcPoints = data.timestamps.map((timestamp, i) => {
            const x = margin.left + (timestamps.indexOf(timestamp) * xScale);
            const y = height - margin.bottom - ((data.gcTime?.[i] || 0) * yScale);
            return `${x},${y}`;
        }).join(' ');
        svg += `<polyline points="${gcPoints}" stroke="${color}" stroke-width="2.5" fill="none" opacity="0.95"/>\n`;

        // Legend for this process
        svg += `<rect x="${width - margin.right + 40}" y="${legendY - 10}" width="20" height="6" fill="${color}" opacity="0.95"/>\n`;
        svg += `<text x="${width - margin.right + 70}" y="${legendY - 2}" font-size="14" fill="#333">${key} (GC Time)</text>\n`;
        legendY += 30;
    });

    // Draw aggregated GC time line (red, solid)
    const aggregatedPoints = timestamps.map((timestamp, i) => {
        const x = margin.left + (i * xScale);
        const y = height - margin.bottom - (aggregatedGcTime[i] * yScale);
        return `${x},${y}`;
    }).join(' ');
    svg += `<polyline points="${aggregatedPoints}" stroke="${aggGcColor}" stroke-width="3.5" fill="none" opacity="0.9"/>\n`;

    // Aggregated legend
    svg += `<rect x="${width - margin.right + 40}" y="${legendY - 10}" width="20" height="20" fill="${aggGcColor}" opacity="0.9"/>\n`;
    svg += `<text x="${width - margin.right + 70}" y="${legendY + 5}" font-size="14" fill="#333">Aggregated GC Time</text>\n`;

    // Add axis labels
    svg += `<text x="${width/2}" y="${height - 10}" text-anchor="middle" font-size="16" fill="#333">Time</text>\n`;
    svg += `<text x="${margin.left - 60}" y="${height/2}" text-anchor="middle" transform="rotate(-90 ${margin.left - 60},${height/2})" font-size="16" fill="#333">GC Time (seconds)</text>\n`;

    svg += '</svg>';
    return svg;
}

async function markProcessAsFinished(runId: string): Promise<void> {
    try {
        const backendUrl = process.env.BACKEND_URL;
        
        if (backendUrl) {
            // Use backend API to mark as finished
            console.log(`🏁 Marking run ${runId} as finished via backend API...`);
            
            // Get JWT token for this run
            console.log(`🔐 Requesting JWT token for run ${runId}...`);
            const authResponse = await fetch(`${backendUrl}/auth/run/${runId}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
            });
            
            if (!authResponse.ok) {
                console.error(`❌ Failed to get JWT token: ${authResponse.status} ${authResponse.statusText}`);
                await markProcessAsFinishedDirect(runId);
                return;
            }
            
            const authData = await authResponse.json();
            const token = authData.token;
            console.log(`✅ JWT token obtained for run ${runId}`);
            
            // Call finish endpoint with JWT token
            const response = await fetch(`${backendUrl}/finish/${runId}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                },
            });
            
            if (response.ok) {
                const result = await response.json();
                console.log(`✅ Successfully marked run ${runId} as finished via backend:`, result.message);
            } else {
                console.error(`❌ Backend API failed to mark run as finished: ${response.status} ${response.statusText}`);
                // Fall back to direct Firestore update
                await markProcessAsFinishedDirect(runId);
            }
        } else {
            // Fall back to direct Firestore update
            await markProcessAsFinishedDirect(runId);
        }
    } catch (error) {
        console.error('❌ Error marking process as finished:', error);
        // Don't throw error - this is not critical for the cleanup process
    }
}

async function markProcessAsFinishedDirect(runId: string): Promise<void> {
    try {
        // Initialize Firebase Admin SDK
        const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || './test-key-new.json';
        const projectId = process.env.GOOGLE_CLOUD_PROJECT || 'process-watcher-68e14';
        
        if (!fs.existsSync(serviceAccountPath)) {
            console.log('⚠️  Service account key not found, skipping direct Firestore update');
            return;
        }

        initializeApp({
            credential: cert(serviceAccountPath),
            projectId: projectId
        });

        const db = getFirestore();
        const docRef = db.collection('runs').doc(runId);
        
        // Update the document to mark it as finished
        await docRef.update({
            finished: true,
            finished_at: new Date(),
            updated_at: new Date()
        });
        
        console.log(`✅ Marked run ${runId} as finished in Firestore directly`);
    } catch (error) {
        console.error('❌ Error marking process as finished directly:', error);
        // Don't throw error - this is not critical for the cleanup process
    }
}

// Global flag to prevent multiple cleanup runs
let cleanupExecuted = false;

async function run() {
    try {
        // Prevent multiple cleanup executions
        if (cleanupExecuted) {
            return;
        }
        cleanupExecuted = true;
        
        // Check debug mode from environment variable
        const debugMode = process.env.DEBUG_MODE === 'true';
        
        // Kill the monitor process if it's still running
        try {
            const pid = fs.readFileSync('monitor.pid', 'utf8').trim();
            process.kill(parseInt(pid));
            if (debugMode) {
                console.log(`Killed monitor process with PID ${pid}`);
            }
        } catch (error) {
            if (debugMode) {
                console.log('No monitor process found to kill');
            }
        }

        // Mark the process as finished in Firestore if we have a run ID
        const runId = process.env.RUN_ID || process.env.GITHUB_RUN_ID;
        if (runId) {
            if (debugMode) {
                console.log(`🏁 Marking run ${runId} as finished...`);
            }
            await markProcessAsFinished(runId);
        } else {
            if (debugMode) {
                console.log('⚠️  No run ID found, skipping Firestore update');
            }
        }

        // Print backend debug log if it exists (only in debug mode)
        const actionDir = process.env.GITHUB_ACTION_PATH || __dirname;
        const backendDebugLog = path.join(actionDir, '..', 'backend_debug.log');
        if (fs.existsSync(backendDebugLog) && debugMode) {
            console.log('\n🔍 Backend Debug Log:');
            console.log('==========================================');
            const debugContent = fs.readFileSync(backendDebugLog, 'utf8');
            console.log(debugContent);
            console.log('==========================================\n');
        }

        // Check if we have a log file
        // The monitor script creates files in the action directory, not the project directory
        const logFile = path.join(actionDir, '..', 'build_process_watcher.log');
        const backendMode = process.env.ENABLE_BACKEND === 'true' || process.env.BACKEND_URL;
        
        if (debugMode) {
            console.log(`🔍 Debug: Current working directory: ${process.cwd()}`);
            console.log(`🔍 Debug: Looking for log file: ${logFile}`);
            console.log(`🔍 Debug: Log file exists: ${fs.existsSync(logFile)}`);
            console.log(`🔍 Debug: Backend mode: ${backendMode}`);
            
            // List all files in current directory
            try {
                const files = fs.readdirSync('.');
                console.log(`🔍 Debug: Files in current directory: ${files.join(', ')}`);
            } catch (err) {
                console.log(`🔍 Debug: Error listing directory: ${err}`);
            }
        }
        
        if (!fs.existsSync(logFile)) {
            if (backendMode) {
                // Always show the dashboard URL for remote monitoring
                // Check if frontend URL is explicitly set, otherwise derive from backend URL or environment
                let frontendUrl = '';
                const explicitFrontendUrl = process.env.FRONTEND_URL || '';
                
                if (explicitFrontendUrl) {
                    // Use explicit frontend URL
                    frontendUrl = `${explicitFrontendUrl}/runs/${runId}`;
                } else {
                    // Derive frontend URL from backend URL pattern or environment
                    const backendUrl = process.env.BACKEND_URL || '';
                    const environment = process.env.ENVIRONMENT || 'production';
                    let baseFrontendUrl = 'https://process-watcher.web.app';
                    
                    // Check environment first, then backend URL pattern as fallback
                    if (environment === 'staging' || backendUrl.includes('-staging')) {
                        baseFrontendUrl = 'https://build-process-watcher-staging.web.app';
                    }
                    
                    frontendUrl = `${baseFrontendUrl}/runs/${runId}`;
                }
                
                console.log(`🌐 Dashboard URL: ${frontendUrl}`);
                
                if (debugMode) {
                    console.log('Backend mode detected - no local log file to process');
                    console.log('Data has been sent to the backend and can be viewed at:');
                    console.log(`- Frontend: ${frontendUrl}`);
                    console.log(`- Backend API: ${process.env.BACKEND_URL || 'not configured'}`);
                }
            } else {
                if (debugMode) {
                    console.log('No log file found');
                }
            }
            return;
        }

        // Parse log file
        if (debugMode) {
            console.log('Generating memory usage graph...');
        }
        const { processes, timestamps, hasGcData } = parseLogFile(logFile);
        
        // Generate both charts
        const mermaidChart = generateMermaidChart(processes, timestamps);
        const svgContent = generateSvg(processes, timestamps);

        // Save SVG file
        fs.writeFileSync('memory_usage.svg', svgContent);

        // Generate GC SVG if GC data is available
        if (hasGcData) {
            if (debugMode) {
                console.log('Generating GC time graph...');
            }
            const gcSvgContent = generateGcSvg(processes, timestamps);
            fs.writeFileSync('gc_time.svg', gcSvgContent);
        }

        // Upload artifacts (only if files exist)
        // Only upload artifacts if we're in a GitHub Actions context and have runtime token
        // When called from script trap, we might not have the token, so skip upload
        const isGitHubActions = process.env.GITHUB_ACTIONS === 'true';
        const hasRuntimeToken = process.env.ACTIONS_RUNTIME_TOKEN !== undefined || 
                               process.env.GITHUB_TOKEN !== undefined;
        
        if (isGitHubActions && hasRuntimeToken) {
            try {
                const artifactClient = new DefaultArtifactClient();
                // Create unique artifact name using job ID and run attempt to avoid conflicts
                const jobId = process.env.GITHUB_JOB || 'default';
                const runAttempt = process.env.GITHUB_RUN_ATTEMPT || '1';
                const timestamp = Date.now();
                const artifactName = `build_process_watcher-${jobId}-${runAttempt}-${timestamp}`;
                const files = [];
                
                // Only include files that exist
                if (fs.existsSync('build_process_watcher.log')) {
                    files.push('build_process_watcher.log');
                }
                if (fs.existsSync('memory_usage.svg')) {
                    files.push('memory_usage.svg');
                }
                if (fs.existsSync('gc_time.svg')) {
                    files.push('gc_time.svg');
                }
                if (fs.existsSync('backend_debug.log')) {
                    files.push('backend_debug.log');
                }
                
                if (files.length > 0) {
                    if (debugMode) {
                        console.log('Uploading artifacts...');
                    }
                    await artifactClient.uploadArtifact(artifactName, files, '.');
                    if (debugMode) {
                        console.log('Successfully uploaded artifacts');
                    }
                } else {
                    if (debugMode) {
                        console.log('No artifacts to upload');
                    }
                }
            } catch (error) {
                // Silently skip artifact upload if it fails (e.g., missing runtime token)
                if (debugMode) {
                    console.log(`⚠️  Skipping artifact upload: ${error instanceof Error ? error.message : 'unknown error'}`);
                }
            }
        } else {
            if (debugMode) {
                if (!isGitHubActions) {
                    console.log('⚠️  Not in GitHub Actions context, skipping artifact upload');
                } else if (!hasRuntimeToken) {
                    console.log('⚠️  No runtime token available, skipping artifact upload');
                }
            }
        }

        // Add to GitHub Actions summary (always generated)
        if (process.env.GITHUB_STEP_SUMMARY) {
            const summary = fs.readFileSync(process.env.GITHUB_STEP_SUMMARY, 'utf8');

            if (backendMode && runId) {
                // Remote monitoring mode - show dashboard info + Mermaid diagram if data available
                const frontendUrl = `https://process-watcher.web.app/runs/${runId}`;
                
                let newSummary = `${summary}

## Build Process Monitoring

### Remote Monitoring Mode
- **Dashboard URL**: ${frontendUrl} (**Data Retention**: 3 hours)
`;

                // Add Mermaid diagram if we have local data
                if (fs.existsSync(logFile) && processes.size > 0) {
                    const maxRss = Math.max(...Array.from(processes.values()).flatMap(p => p.rss));
                    const processCount = processes.size;
                    const duration = timestamps.length > 0 ?
                        `from ${timestamps[0]} to ${timestamps[timestamps.length - 1]}` :
                        'N/A';

                    newSummary += `

### Build Process Graph
\`\`\`mermaid
${mermaidChart}
\`\`\`

### Overview
- Number of processes monitored: ${processCount}
- Maximum RSS observed: ${maxRss.toFixed(2)} MB
- Monitoring duration: ${duration}

### Process Details
${Array.from(processes.entries()).map(([key, data]) => {
    const maxProcessRss = Math.max(...data.rss);
    const avgProcessRss = data.rss.reduce((a, b) => a + b, 0) / data.rss.length;
    const lastRss = data.rss[data.rss.length - 1];
    return `#### ${key}
- Maximum RSS: ${maxProcessRss.toFixed(2)} MB
- Average RSS: ${avgProcessRss.toFixed(2)} MB
- Number of measurements: ${data.rss.length}
- Last measurement: ${lastRss.toFixed(2)} MB`;
}).join('\n\n')}

> Note: A detailed SVG graph and log file are available in the artifacts of this workflow run.`;
                }

                fs.writeFileSync(process.env.GITHUB_STEP_SUMMARY, newSummary);
            } else if (fs.existsSync(logFile)) {
                // Local monitoring mode - show analysis
                const maxRss = Math.max(...Array.from(processes.values()).flatMap(p => p.rss));
                const processCount = processes.size;
                const duration = timestamps.length > 0 ?
                    `from ${timestamps[0]} to ${timestamps[timestamps.length - 1]}` :
                    'N/A';

                const newSummary = `${summary}

## Build Process Analysis

### Build Process Graph
\`\`\`mermaid
${mermaidChart}
\`\`\`

### Overview
- Number of processes monitored: ${processCount}
- Maximum RSS observed: ${maxRss.toFixed(2)} MB
- Monitoring duration: ${duration}

### Process Details
${Array.from(processes.entries()).map(([key, data]) => {
    const maxProcessRss = Math.max(...data.rss);
    const avgProcessRss = data.rss.reduce((a, b) => a + b, 0) / data.rss.length;
    const lastRss = data.rss[data.rss.length - 1];
    return `#### ${key}
- Maximum RSS: ${maxProcessRss.toFixed(2)} MB
- Average RSS: ${avgProcessRss.toFixed(2)} MB
- Number of measurements: ${data.rss.length}
- Last measurement: ${lastRss.toFixed(2)} MB`;
}).join('\n\n')}

> Note: A detailed SVG graph and log file are available in the artifacts of this workflow run.`;

                fs.writeFileSync(process.env.GITHUB_STEP_SUMMARY, newSummary);
            }
        }
    } catch (error) {
        console.error('Error during cleanup:', error);
        process.exit(1);
    }
}

run();
