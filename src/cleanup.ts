import { stopDaemonitor, daemonitorArtifacts } from './lib/daemonitor';
import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as core from '@actions/core';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { generateJsonReport, generateCsvReport } from './lib/report';
import { generateCombinedMermaidChart, MermaidProcessData } from './lib/mermaid';
import { generateSvg, generateGcSvg, generateMetricSvg, lastNonNull } from './lib/report_svg';
import { artifactSummary, existingArtifactPaths, resolveMonitorDebugLogPaths } from './lib/artifacts';
import { finishRunViaBackend, RunFinisherError } from './lib/run_finisher';
import { parseLogSamples } from './lib/log_samples';
import { LogParseResult, parseLogContents } from './lib/log_parser';
export { parseLogContents } from './lib/log_parser';
import { resolveRunIdentity } from './lib/run_identity';
import {
    ACTION_RUNTIME_STATE_FILE_NAMES,
    ACTION_RUNTIME_STATE_FILES,
    actionRuntimeStateFilePath,
    getActionRuntimeTempRoot,
    resolveActionRuntimeStateCandidateDirs,
    resolveRunIdBackupCandidateFiles,
} from './action_config';
import { resolveCleanupLogFile } from './cleanup_context';

const execAsync = promisify(exec);

type ProcessData = MermaidProcessData;

function parseLogFile(logFile: string): LogParseResult {
    return parseLogContents(fs.readFileSync(logFile, 'utf8'));
}

async function markProcessAsFinished(runId: string): Promise<void> {
    try {
        let backendUrl = '';
        const workspaceDir = process.env.GITHUB_WORKSPACE;
        const runnerTempDir = process.env.RUNNER_TEMP;
        const candidateDirs = resolveActionRuntimeStateCandidateDirs({
            cwd: process.cwd(),
            workspaceDir,
            runnerTempRoot: runnerTempDir,
            runId,
        });
        for (const dir of candidateDirs) {
            const backendFile = actionRuntimeStateFilePath(dir, ACTION_RUNTIME_STATE_FILES.backendUrl);
            if (fs.existsSync(backendFile)) {
                backendUrl = fs.readFileSync(backendFile, 'utf8').trim();
                break;
            }
        }
        const backendEnabled = process.env.ENABLE_BACKEND === 'true';
        
        if (!backendEnabled) {
            console.log(`ℹ️  Remote monitoring disabled; skipping finish for run ${runId}`);
            return;
        }

        if (backendUrl) {
            // Use backend API to mark as finished
            console.log(`🏁 Marking run ${runId} as finished via backend API...`);

            try {
                console.log(`🔐 Requesting JWT token for run ${runId}...`);
                const result = await finishRunViaBackend(backendUrl, runId);
                console.log(`✅ JWT token obtained for run ${runId}`);
                console.log(`✅ Successfully marked run ${runId} as finished via backend: ${result.message || 'OK'}`);
            } catch (error) {
                if (error instanceof RunFinisherError) {
                    if (error.phase === 'auth') {
                        console.error(`❌ Failed to get JWT token: ${error.status} ${error.statusText}`);
                    } else {
                        console.error(`❌ Backend API failed to mark run as finished: ${error.status} ${error.statusText}`);
                    }
                    console.error(`   Error details: ${error.errorText}`);
                    console.log(`🔄 Falling back to direct Firestore update...`);
                    await markProcessAsFinishedDirect(runId);
                } else {
                    throw error;
                }
            }
        } else {
            console.log(`🏁 Backend URL not available, using direct Firestore update for run ${runId}...`);
            // Fall back to direct Firestore update
            await markProcessAsFinishedDirect(runId);
        }
    } catch (error) {
        console.error(`❌ Error marking process as finished for run ${runId}:`, error);
        // Try direct Firestore update as last resort
        try {
            console.log(`🔄 Attempting direct Firestore update as last resort...`);
            await markProcessAsFinishedDirect(runId);
        } catch (directError) {
            console.error(`❌ Direct Firestore update also failed:`, directError);
        }
        // Don't throw error - this is not critical for the cleanup process
    }
}

async function markProcessAsFinishedDirect(runId: string): Promise<void> {
    try {
        // Initialize Firebase Admin SDK
        const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || './test-key-new.json';
        const projectId = process.env.GOOGLE_CLOUD_PROJECT || 'process-watcher-68e14';
        
        if (!fs.existsSync(serviceAccountPath)) {
            console.log(`⚠️  Service account key not found at ${serviceAccountPath}, skipping direct Firestore update`);
            console.log(`   This is expected in GitHub Actions - backend API should be used instead`);
            return;
        }

        console.log(`🔧 Initializing Firebase Admin SDK for direct Firestore update...`);
        initializeApp({
            credential: cert(serviceAccountPath),
            projectId: projectId
        });

        const db = getFirestore();
        const docRef = db.collection('runs').doc(runId);
        
        // Update the document to mark it as finished
        const now = new Date();
        await docRef.update({
            finished: true,
            finished_at: now,
            updated_at: now
        });
        
        console.log(`✅ Marked run ${runId} as finished in Firestore directly at ${now.toISOString()}`);
    } catch (error) {
        console.error(`❌ Error marking process as finished directly for run ${runId}:`, error);
        // Don't throw error - this is not critical for the cleanup process
    }
}

// File-based lock to prevent multiple cleanup runs across different processes
const LOCK_FILE = 'cleanup.lock';

function acquireLock(): boolean {
    try {
        // Try to create lock file exclusively
        const fd = fs.openSync(LOCK_FILE, 'wx');
        fs.closeSync(fd);
        return true;
    } catch (error) {
        // Lock file exists or other error - cleanup already running
        return false;
    }
}

function releaseLock(): void {
    try {
        if (fs.existsSync(LOCK_FILE)) {
            fs.unlinkSync(LOCK_FILE);
        }
    } catch (error) {
        // Ignore errors when releasing lock
    }
}

function removeIfExists(filePath: string, debugMode: boolean): void {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            if (debugMode) {
                console.log(`🧹 Removed temporary file: ${filePath}`);
            }
        }
    } catch (error) {
        if (debugMode) {
            console.log(`⚠️  Could not remove temporary file ${filePath}: ${error instanceof Error ? error.message : error}`);
        }
    }
}

function copyIfExists(sourcePath: string, destinationDir: string, debugMode: boolean): void {
    try {
        if (!fs.existsSync(sourcePath)) return;
        const destinationPath = path.join(destinationDir, path.basename(sourcePath));
        if (path.resolve(sourcePath) === path.resolve(destinationPath)) return;
        fs.copyFileSync(sourcePath, destinationPath);
        if (debugMode) {
            console.log(`📦 Copied artifact to workspace: ${destinationPath}`);
        }
    } catch (error) {
        if (debugMode) {
            console.log(`⚠️  Could not copy artifact ${sourcePath}: ${error instanceof Error ? error.message : error}`);
        }
    }
}

function cleanupWorkspaceLeftovers(logFile: string | null, debugMode: boolean): void {
    const workspaceDir = process.env.GITHUB_WORKSPACE;
    const runnerTempDir = process.env.RUNNER_TEMP;
    const runId = process.env.RUN_ID;
    const defaultLogFile = process.env.BPW_LOG_FILE_DEFAULT !== 'false';
    const candidateDirs = resolveActionRuntimeStateCandidateDirs({
        cwd: process.cwd(),
        workspaceDir,
        runnerTempRoot: runnerTempDir,
        runId,
        includeRunnerTempRoot: true,
    });

    candidateDirs.forEach(dir => {
        ACTION_RUNTIME_STATE_FILE_NAMES.forEach(file => removeIfExists(actionRuntimeStateFilePath(dir, file), debugMode));
    });

    if (logFile && defaultLogFile) {
        removeIfExists(logFile, debugMode);
        removeIfExists(logFile.replace(/\.log$/, '.process_info'), debugMode);
    }

    if (workspaceDir && runId && defaultLogFile) {
        const outputSuffix = `-${runId}`;
        [
            'build_process_watcher.log',
            'build_process_watcher.process_info',
            `memory_usage${outputSuffix}.svg`,
            `gc_time${outputSuffix}.svg`,
            `jit_compilation${outputSuffix}.svg`,
            `class_loading${outputSuffix}.svg`,
            `build_process_watcher${outputSuffix}.csv`,
            `build_process_watcher${outputSuffix}.json`
        ].forEach(file => removeIfExists(path.join(workspaceDir, file), debugMode));
    }
}

async function run() {
    // Prevent multiple cleanup executions using file-based lock
    if (!acquireLock()) {
        const debugMode = process.env.DEBUG_MODE === 'true';
        if (debugMode) {
            console.log('⚠️  Cleanup already running, skipping duplicate execution');
        }
        return;
    }
    const debugMode = process.env.DEBUG_MODE === 'true';
    const isTrapHandler = process.env.CLEANUP_FROM_TRAP === 'true';
    let resolvedLogFile: string | null = null;
    let collectorUploadsComplete = true;
    const collector = core.getState('collector') || process.env.BPW_COLLECTOR || 'shell';
    const daemonitorState = core.getState('daemonitor_state_dir') || process.env.BPW_DAEMONITOR_STATE_DIR;
    const collectorArtifacts: string[] = [];
    
    try {
        
        // Check debug mode from environment variable
        
        // Daemonitor must drain its outbox before run completion triggers BigQuery export.
        if (collector === 'daemonitor') {
            if (!daemonitorState) throw new Error('Missing Daemonitor collector state');
            const stopped = await stopDaemonitor(daemonitorState);
            process.env.LOG_FILE = stopped.config.logFile;
            process.env.RUN_ID = stopped.config.runId;
            collectorUploadsComplete = stopped.complete && !stopped.error;
            if (!collectorUploadsComplete) core.setFailed(`Daemonitor run will remain unfinished: ${stopped.error || 'pending uploads'}`);
            const outputDir = path.dirname(stopped.config.logFile);
            for (const file of daemonitorArtifacts(stopped.config)) {
                if (!fs.existsSync(file)) continue;
                const artifactRunId = stopped.config.runId.replace(/[^a-zA-Z0-9_.-]/g, '_');
                const destination = path.join(outputDir, `daemonitor-${artifactRunId}-${path.basename(file)}`);
                fs.copyFileSync(file, destination);
                collectorArtifacts.push(destination);
            }
        } else try {
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

        // Mark the process as finished in Firestore if we have a run ID.
        const identityWorkspaceDir = process.env.GITHUB_WORKSPACE;
        const identityRunnerTempDir = process.env.RUNNER_TEMP;
        const runtimeTempRoot = identityRunnerTempDir ? getActionRuntimeTempRoot(identityRunnerTempDir) : '';
        const tempRunEntries = runtimeTempRoot && fs.existsSync(runtimeTempRoot)
            ? fs.readdirSync(runtimeTempRoot)
            : [];
        const runIdentity = resolveRunIdentity({
            environmentRunId: process.env.RUN_ID,
            backupFiles: resolveRunIdBackupCandidateFiles({
                cwd: process.cwd(),
                workspaceDir: identityWorkspaceDir,
                runnerTempRoot: identityRunnerTempDir,
                runnerTempRunEntries: tempRunEntries,
            }),
            debugLogFile: path.join(process.env.GITHUB_ACTION_PATH || __dirname, '..', 'backend_debug.log'),
            githubRunId: process.env.GITHUB_RUN_ID,
        });
        const runId = runIdentity.runId;

        if (runId && runIdentity.source === 'backup-file') {
            console.log(`📋 Read RUN_ID from file: ${runId}`);
        } else if (runId && runIdentity.source === 'debug-log') {
            console.log(`📋 Extracted RUN_ID from log file: ${runId}`);
        } else if (runId && runIdentity.source === 'github-run') {
            console.log(`📋 Using GITHUB_RUN_ID as fallback: ${runId}`);
        }
        
        // Only mark as finished for remote monitoring runs
        if (runId && process.env.ENABLE_BACKEND === 'true' && collectorUploadsComplete) {
            console.log(`🏁 Marking run ${runId} as finished...`);
            try {
                await markProcessAsFinished(runId);
            } catch (error) {
                console.error(`❌ Failed to mark run ${runId} as finished:`, error);
                // Don't throw - we want cleanup to continue even if marking fails
            }
        } else if (runId && !collectorUploadsComplete) {
            core.warning(`Run ${runId} has incomplete collector delivery; inspect the Daemonitor outbox artifact`);
        } else if (runId) {
            console.log(`ℹ️  Remote monitoring disabled; skipping finish for run ${runId}`);
        } else {
            console.log('⚠️  No run ID found, skipping Firestore update');
            console.log('   Available env vars:', Object.keys(process.env).filter(k => k.includes('RUN') || k.includes('GITHUB')).join(', ') || 'none');
        }

        const actionDir = process.env.GITHUB_ACTION_PATH || __dirname;

        // Print summary statistics if available (for backend mode)
        const successfulCallsFile = path.join(actionDir, '..', 'successful_calls_count.txt');
        const failedCallsFile = path.join(actionDir, '..', 'failed_calls_count.txt');
        
        let successfulCount = 0;
        let failedCount = 0;
        let hasStats = false;
        
        if (fs.existsSync(successfulCallsFile)) {
            try {
                const successfulCalls = fs.readFileSync(successfulCallsFile, 'utf8').trim();
                const count = parseInt(successfulCalls, 10);
                if (!isNaN(count)) {
                    successfulCount = count;
                    hasStats = true;
                }
            } catch (error) {
                // Silently ignore errors reading the file
            }
        }
        
        if (fs.existsSync(failedCallsFile)) {
            try {
                const failedCalls = fs.readFileSync(failedCallsFile, 'utf8').trim();
                const count = parseInt(failedCalls, 10);
                if (!isNaN(count)) {
                    failedCount = count;
                    hasStats = true;
                }
            } catch (error) {
                // Silently ignore errors reading the file
            }
        }
        
        if (hasStats) {
            const totalCalls = successfulCount + failedCount;
            const successRate = totalCalls > 0 ? ((successfulCount / totalCalls) * 100).toFixed(1) : '0.0';
            
            console.log('');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('📊 Build Process Watcher - Summary Statistics');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log(`✅ Total successful backend calls: ${successfulCount}`);
            console.log(`❌ Total failed backend calls: ${failedCount}`);
            console.log(`📈 Total calls: ${totalCalls}`);
            console.log(`📊 Success rate: ${successRate}%`);
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('');
        }

        // Check if we have a log file
        // The monitor script creates files in the action directory, not the project directory
        const logFileName = process.env.LOG_FILE || 'build_process_watcher.log';
        const workspaceDir = process.env.GITHUB_WORKSPACE;
        const runnerTempDir = process.env.RUNNER_TEMP;
        const logFile = resolveCleanupLogFile({
            logFileName,
            actionDir,
            workspaceDir,
            runnerTempRoot: runnerTempDir,
            runId,
            exists: filePath => fs.existsSync(filePath),
        });
        resolvedLogFile = logFile;
        const backendMode = process.env.ENABLE_BACKEND === 'true';
        const monitorDebugLogsForPrint = resolveMonitorDebugLogPaths({
            logFile,
            actionPath: process.env.GITHUB_ACTION_PATH || null,
            actionBundleDir: actionDir,
            cwd: process.cwd(),
        });
        if (monitorDebugLogsForPrint.backendDebugLog && debugMode) {
            console.log('\n🔍 Backend Debug Log:');
            console.log('==========================================');
            console.log(fs.readFileSync(monitorDebugLogsForPrint.backendDebugLog, 'utf8'));
            console.log('==========================================\n');
        }
        if (monitorDebugLogsForPrint.scriptDebugLog && debugMode) {
            console.log('\n🔍 Script Debug Log:');
            console.log('==========================================');
            console.log(fs.readFileSync(monitorDebugLogsForPrint.scriptDebugLog, 'utf8'));
            console.log('==========================================\n');
        }
        
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
                let explicitFrontendUrl = '';
                const workspaceDir = process.env.GITHUB_WORKSPACE;
                const runnerTempDir = process.env.RUNNER_TEMP;
                const candidateDirs = resolveActionRuntimeStateCandidateDirs({
                    cwd: process.cwd(),
                    workspaceDir,
                    runnerTempRoot: runnerTempDir,
                    runId,
                });
                for (const dir of candidateDirs) {
                    const frontendFile = actionRuntimeStateFilePath(dir, ACTION_RUNTIME_STATE_FILES.frontendUrl);
                    if (fs.existsSync(frontendFile)) {
                        explicitFrontendUrl = fs.readFileSync(frontendFile, 'utf8').trim();
                        break;
                    }
                }
                
                if (explicitFrontendUrl) {
                    // Use explicit frontend URL
                    frontendUrl = `${explicitFrontendUrl}/runs/${runId}`;
                } else {
                    // Derive frontend URL from backend URL pattern or environment
                    let baseFrontendUrl = 'https://process-watcher.web.app';
                    
                    frontendUrl = `${baseFrontendUrl}/runs/${runId}`;
                }
                
                console.log(`🌐 Dashboard URL: ${frontendUrl}`);
                
                if (debugMode) {
                    console.log('Backend mode detected - no local log file to process');
                    console.log('Data has been sent to the backend and can be viewed at:');
                    console.log(`- Frontend: ${frontendUrl}`);
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
        const { processes, timestamps, hasGcData, hasJitData, hasClassData } = parseLogFile(logFile);
        
        // Generate both charts
        const mermaidChart = generateCombinedMermaidChart(processes, timestamps);
        const svgContent = generateSvg(processes, timestamps);

        const outputDir = path.dirname(logFile);
        const outputSuffix = runId ? `-${runId}` : '';
        const memorySvgFile = `memory_usage${outputSuffix}.svg`;
        const gcSvgFile = `gc_time${outputSuffix}.svg`;
        const jitSvgFile = `jit_compilation${outputSuffix}.svg`;
        const classSvgFile = `class_loading${outputSuffix}.svg`;
        const csvFile = `build_process_watcher${outputSuffix}.csv`;
        const jsonFile = `build_process_watcher${outputSuffix}.json`;

        // Save SVG file
        fs.writeFileSync(path.join(outputDir, memorySvgFile), svgContent);

        // Generate GC SVG (includes a fallback message if no GC data)
        if (debugMode) {
            console.log('Generating GC time graph...');
        }
        const gcSvgContent = generateGcSvg(processes, timestamps);
        fs.writeFileSync(path.join(outputDir, gcSvgFile), gcSvgContent);

        if (hasJitData) {
            if (debugMode) {
                console.log('Generating JIT compilation graph...');
            }
            const jitSvgContent = generateMetricSvg(processes, timestamps, {
                title: 'Build Process JIT Compiled Methods Over Time',
                yAxisLabel: 'Compiled Methods',
                noDataMessage: 'No JIT compilation data available',
                metric: process => process.jitCompiledMethods
            });
            fs.writeFileSync(path.join(outputDir, jitSvgFile), jitSvgContent);
        }

        if (hasClassData) {
            if (debugMode) {
                console.log('Generating class loading graph...');
            }
            const classSvgContent = generateMetricSvg(processes, timestamps, {
                title: 'Build Process Classes Loaded Over Time',
                yAxisLabel: 'Classes Loaded',
                noDataMessage: 'No class loading data available',
                metric: process => process.classesLoaded
            });
            fs.writeFileSync(path.join(outputDir, classSvgFile), classSvgContent);
        }

        generateCsvReport(logFile, path.join(outputDir, csvFile), hasGcData);
        generateJsonReport(logFile, path.join(outputDir, jsonFile), hasGcData);

        const workspaceOutputDir = process.env.GITHUB_WORKSPACE;
        if (workspaceOutputDir && path.resolve(outputDir) !== path.resolve(workspaceOutputDir)) {
            [
                ...collectorArtifacts,
                logFile,
                logFile.replace(/\.log$/, '.process_info'),
                path.join(outputDir, memorySvgFile),
                path.join(outputDir, gcSvgFile),
                path.join(outputDir, jitSvgFile),
                path.join(outputDir, classSvgFile),
                path.join(outputDir, csvFile),
                path.join(outputDir, jsonFile)
            ].forEach(file => copyIfExists(file, workspaceOutputDir, debugMode));
        }

        // Upload artifacts (only if files exist)
        // Only upload artifacts if we're in a GitHub Actions context and have runtime token
        // When called from script trap, we might not have the token, so skip upload
        const isGitHubActions = process.env.GITHUB_ACTIONS === 'true';
        const hasRuntimeToken = process.env.ACTIONS_RUNTIME_TOKEN !== undefined || 
                               process.env.GITHUB_TOKEN !== undefined;
        let uploadedArtifact: { name: string, files: string[] } | null = null;
        
        // Check if we're being called from a trap handler (they set a marker env var)
        // or if we're the first cleanup (post action) - only upload once
        const shouldUpload = !isTrapHandler && isGitHubActions && hasRuntimeToken;
        
        if (shouldUpload) {
            try {
                const { DefaultArtifactClient } = await import('@actions/artifact');
                const artifactClient = new DefaultArtifactClient();
                // Create stable artifact name using job name and run attempt
                const jobName = process.env.GITHUB_JOB || 'default';
                const runAttempt = process.env.GITHUB_RUN_ATTEMPT || '1';
                
                // Use job name in artifact name (run attempt avoids duplicates on re-runs)
                const artifactName = `build_process_watcher-${jobName}-${runAttempt}${collector === 'daemonitor' ? '-daemonitor' : ''}`;
                
                const artifactCandidates = [
                    ...collectorArtifacts,
                    logFile,
                    path.join(outputDir, memorySvgFile),
                    path.join(outputDir, gcSvgFile),
                    path.join(outputDir, jitSvgFile),
                    path.join(outputDir, classSvgFile),
                    path.join(outputDir, csvFile),
                    path.join(outputDir, jsonFile)
                ];
                // Always archive monitor debug logs when present (needed to diagnose collector stalls).
                const monitorDebugLogs = resolveMonitorDebugLogPaths({
                    logFile,
                    actionPath: process.env.GITHUB_ACTION_PATH || null,
                    actionBundleDir: actionDir,
                    cwd: process.cwd(),
                });
                const debugLogCopies: Array<{ source: string; name: string }> = [];
                if (monitorDebugLogs.backendDebugLog) {
                    debugLogCopies.push({
                        source: monitorDebugLogs.backendDebugLog,
                        name: `backend_debug${outputSuffix}.log`,
                    });
                }
                if (monitorDebugLogs.scriptDebugLog) {
                    debugLogCopies.push({
                        source: monitorDebugLogs.scriptDebugLog,
                        name: `script_debug${outputSuffix}.log`,
                    });
                }
                for (const entry of debugLogCopies) {
                    const debugCopy = path.join(outputDir, entry.name);
                    if (!fs.existsSync(debugCopy)) {
                        fs.copyFileSync(entry.source, debugCopy);
                    }
                    artifactCandidates.push(debugCopy);
                    console.log(`📎 Including monitor debug log in artifacts: ${entry.name}`);
                }
                const files = existingArtifactPaths(artifactCandidates);
                
                if (files.length > 0) {
                    if (debugMode) {
                        console.log('Uploading artifacts...');
                    }
                    await artifactClient.uploadArtifact(artifactName, files, path.resolve(outputDir));
                    uploadedArtifact = { name: artifactName, files };
                    if (debugMode) {
                        console.log('Successfully uploaded artifacts');
                    }
                } else {
                    if (debugMode) {
                        console.log('No artifacts to upload');
                    }
                }
            } catch (error) {
                console.log(`⚠️  Artifact upload failed: ${error instanceof Error ? error.message : 'unknown error'}`);
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

        // Add to GitHub Actions summary unless explicitly disabled
        const disableSummaryOutput = process.env.DISABLE_SUMMARY_OUTPUT === 'true';
        const shouldGenerateSummary = !disableSummaryOutput;
        
        if (process.env.GITHUB_STEP_SUMMARY && shouldGenerateSummary) {
            const summary = fs.readFileSync(process.env.GITHUB_STEP_SUMMARY, 'utf8');

            if (backendMode && runId) {
                // Remote monitoring mode - show dashboard info + Mermaid diagram if data available
                const frontendUrl = `https://process-watcher.web.app/runs/${runId}`;
                const summarySubtitle = process.env.GITHUB_JOB || runId || '';
                
                let newSummary = `${summary}

## Build Process Watcher${summarySubtitle ? ` (${summarySubtitle})` : ''}

### Remote Monitoring Mode
- **Dashboard URL**: ${frontendUrl} (**Data Retention**: 24 hours)
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
    const jitStats = hasJitData && data.jitCompiledMethods.some(value => value !== null)
        ? `\n- Last JIT compiled methods: ${lastNonNull(data.jitCompiledMethods) ?? 'N/A'}`
        : '';
    const classStats = hasClassData && data.classesLoaded.some(value => value !== null)
        ? `\n- Last classes loaded: ${lastNonNull(data.classesLoaded) ?? 'N/A'}`
        : '';
    return `#### ${key}
- Maximum RSS: ${maxProcessRss.toFixed(2)} MB
- Average RSS: ${avgProcessRss.toFixed(2)} MB
- Number of measurements: ${data.rss.length}
- Last measurement: ${lastRss.toFixed(2)} MB${jitStats}${classStats}`;
}).join('\n\n')}

                > Note: Detailed SVG graphs and the log file are available in the artifacts of this workflow run.`;
                }

                fs.writeFileSync(process.env.GITHUB_STEP_SUMMARY, newSummary);
            } else if (fs.existsSync(logFile)) {
                // Local monitoring mode - show analysis
                const maxRss = Math.max(...Array.from(processes.values()).flatMap(p => p.rss));
                const processCount = processes.size;
                const duration = timestamps.length > 0 ?
                    `from ${timestamps[0]} to ${timestamps[timestamps.length - 1]}` :
                    'N/A';
                const summarySubtitle = process.env.GITHUB_JOB || runId || '';

                const artifactStatus = uploadedArtifact
                    ? artifactSummary(uploadedArtifact.name, uploadedArtifact.files)
                    : '> ⚠️ Result artifacts were not archived by Build Process Watcher.';

                const newSummary = `${summary}

## Build Process Watcher${summarySubtitle ? ` (${summarySubtitle})` : ''}

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
    const gcStats = hasGcData && data.gcTime && data.gcTime.length > 0
        ? (() => {
            const maxGc = Math.max(...data.gcTime);
            const lastGc = data.gcTime[data.gcTime.length - 1];
            return `\n- Max GC time: ${maxGc.toFixed(3)} s\n- Last GC time: ${lastGc.toFixed(3)} s`;
        })()
        : '';
    const jitStats = hasJitData && data.jitCompiledMethods.some(value => value !== null)
        ? `\n- Last JIT compiled methods: ${lastNonNull(data.jitCompiledMethods) ?? 'N/A'}`
        : '';
    const classStats = hasClassData && data.classesLoaded.some(value => value !== null)
        ? `\n- Last classes loaded: ${lastNonNull(data.classesLoaded) ?? 'N/A'}`
        : '';
    return `#### ${key}
- Maximum RSS: ${maxProcessRss.toFixed(2)} MB
- Average RSS: ${avgProcessRss.toFixed(2)} MB
- Number of measurements: ${data.rss.length}
- Last measurement: ${lastRss.toFixed(2)} MB${gcStats}${jitStats}${classStats}`;
}).join('\n\n')}

${artifactStatus}`;

                fs.writeFileSync(process.env.GITHUB_STEP_SUMMARY, newSummary);
            }
        }
    } catch (error) {
        console.error('Error during cleanup:', error);
        process.exit(1);
    } finally {
        if (!isTrapHandler) {
            cleanupWorkspaceLeftovers(resolvedLogFile, debugMode);
        }
        // Always release the lock
        releaseLock();
    }
}

if (require.main === module) {
    run();
}
