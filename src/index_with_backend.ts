import * as core from '@actions/core';
import * as exec from '@actions/exec';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

async function run() {
  try {
    let backendUrl = process.env.BACKEND_URL || '';
    const enableBackend = core.getInput('remote_monitoring') === 'true';
    const runId = core.getInput('run_id') || `run-${Date.now()}`;
    const debugMode = core.getInput('debug') === 'true';
    const logFileInput = core.getInput('log_file') || 'build_process_watcher.log';
    const workspaceDir = process.env.GITHUB_WORKSPACE;
    let logFilePath = !path.isAbsolute(logFileInput) && workspaceDir
      ? path.join(workspaceDir, logFileInput)
      : logFileInput;
    if (logFileInput === 'build_process_watcher.log' && fs.existsSync(logFilePath)) {
      const logDir = path.dirname(logFilePath);
      logFilePath = path.join(logDir, `build_process_watcher-${runId}.log`);
      if (debugMode) {
        core.info(`🧭 Log file already exists, using: ${logFilePath}`);
      }
    }
    const interval = core.getInput('interval') || '5';
    const disableSummaryOutput = core.getInput('disable_summary_output') === 'true';
    const exportToBigqueryRequested = core.getInput('export_to_bigquery') === 'true';

    // If backend is enabled but no URL provided, use the default Cloud Run URL
    if (enableBackend && !backendUrl) {
      // Default production backend URL
      backendUrl = 'https://build-process-watcher-backend-685615422311.us-central1.run.app';
      if (debugMode) {
        core.info(`🔧 Backend enabled but no URL provided, using default URL: ${backendUrl}`);
      }
    }

    const useBackend = enableBackend && !!backendUrl;
    const exportToBigquery = exportToBigqueryRequested && useBackend;
    if (exportToBigqueryRequested && !useBackend && debugMode) {
      core.info(`ℹ️  export_to_bigquery is ignored without remote_monitoring and a backend URL`);
    }

    // Show mode and essential info
    const mode = enableBackend ? 'Remote Monitoring' : 'Local Monitoring';
    core.info(`🚀 Build Process Watcher - ${mode} Mode`);
    
    if (debugMode) {
      core.info(`📋 Run ID: ${runId}`);
      core.info(`🌐 Backend URL: ${backendUrl || 'Not provided'}`);
      core.info(`⚙️  Remote Monitoring: ${enableBackend}`);
      core.info(`🐛 Debug Mode: ${debugMode}`);
    }

    // Build frontend URL if backend is enabled (do this before exporting)
    let frontendUrl = '';
    if (enableBackend && backendUrl) {
      // Use FRONTEND_URL env var (from secrets) or default
      const explicitFrontendUrl = process.env.FRONTEND_URL || '';
      
      if (explicitFrontendUrl) {
        // Use explicitly provided frontend URL (from env var or input)
        if (explicitFrontendUrl.endsWith('/runs') || explicitFrontendUrl.endsWith('/runs/')) {
          frontendUrl = `${explicitFrontendUrl}/${runId}`;
        } else {
          frontendUrl = `${explicitFrontendUrl}/runs/${runId}`;
        }
        
      } else {
        const baseFrontendUrl = 'https://process-watcher.web.app';
        frontendUrl = `${baseFrontendUrl}/runs/${runId}`;
      }
      
      if (debugMode) {
        core.info(`🌐 Frontend URL: ${frontendUrl}`);
      }
    }

    // Export variables for the cleanup step
    core.exportVariable('ENABLE_BACKEND', enableBackend.toString());
    core.exportVariable('RUN_ID', runId);
    core.exportVariable('LOG_FILE', logFilePath);
    core.exportVariable('DISABLE_SUMMARY_OUTPUT', disableSummaryOutput.toString());
    core.exportVariable('EXPORT_TO_BIGQUERY', exportToBigquery ? 'true' : 'false');
    
    // Also write RUN_ID to a file as a backup for the post step
    // This ensures the post step can always find the RUN_ID even if env vars aren't available
    try {
      const runIdFile = path.join(process.cwd(), '.build-process-watcher-run-id');
      fs.writeFileSync(runIdFile, runId, 'utf8');
      if (debugMode) {
        core.info(`💾 Saved RUN_ID to file: ${runIdFile}`);
      }
      if (workspaceDir) {
        const workspaceRunIdFile = path.join(workspaceDir, '.build-process-watcher-run-id');
        fs.writeFileSync(workspaceRunIdFile, runId, 'utf8');
        if (debugMode) {
          core.info(`💾 Saved RUN_ID to workspace file: ${workspaceRunIdFile}`);
        }
      }
    } catch (error) {
      // Non-critical - env var export should be sufficient
      if (debugMode) {
        core.warning(`⚠️  Failed to write RUN_ID to file: ${error}`);
      }
    }
    if (frontendUrl || backendUrl) {
      try {
        const baseDir = workspaceDir || process.cwd();
        if (backendUrl) {
          fs.writeFileSync(path.join(baseDir, '.build-process-watcher-backend-url'), backendUrl, 'utf8');
        }
        if (frontendUrl) {
          const baseFrontendUrl = frontendUrl.replace(/\/runs\/.*$/, '');
          fs.writeFileSync(path.join(baseDir, '.build-process-watcher-frontend-url'), baseFrontendUrl, 'utf8');
        }
      } catch (error) {
        if (debugMode) {
          core.warning(`⚠️  Failed to write backend/frontend URL files: ${error}`);
        }
      }
    }

    // Set output for use in other steps
    core.setOutput('run_id', runId);
    core.setOutput('backend_url', backendUrl || '');
    core.setOutput('remote_monitoring', enableBackend.toString());
    core.setOutput('frontend_url', frontendUrl);
    core.setOutput('export_to_bigquery', exportToBigquery.toString());

    // Always show the dashboard URL when remote monitoring is enabled (regardless of debug mode)
    if (enableBackend && frontendUrl) {
      core.info(`🌐 Dashboard URL: ${frontendUrl}`);
    }

    // Start monitoring
    const monitoringScript = 'monitor_with_backend.sh';
    
    if (debugMode) {
      core.info(`📜 Using monitoring script: ${monitoringScript}`);
    }
    
    if (enableBackend && backendUrl) {
      if (debugMode) {
        core.info(`🔥 BACKEND INTEGRATION ACTIVE - Data will be sent to: ${backendUrl}`);
        core.info(`📊 Run data will be stored in Firestore with ID: ${runId}`);
      }
    } else {
    if (debugMode) {
      core.info(`📝 LOCAL LOGGING MODE - Data will be saved to: ${logFilePath}`);
      }
    }

    // Execute the monitoring script
    const args = enableBackend && backendUrl 
      ? [interval, backendUrl, runId]  // interval, backend_url, run_id
      : [interval];

    // Get the action's directory (where the dist folder is located)
    const actionDir = __dirname;
    // The monitor scripts are in the parent directory of dist/
    const scriptPath = path.join(actionDir, '..', monitoringScript);
    
    // Check if script exists
    if (!fs.existsSync(scriptPath)) {
      core.setFailed(`❌ Monitor script not found: ${scriptPath}`);
      return;
    }
    
    // Make the script executable
    try {
      await exec.exec('chmod', ['+x', scriptPath]);
      if (debugMode) {
        core.info(`✅ Made script executable: ${scriptPath}`);
      }
    } catch (error) {
      core.warning(`⚠️  Could not make script executable: ${error}`);
    }
    
    if (debugMode) {
      core.info(`▶️  Executing: ${scriptPath} ${args.join(' ')}`);
    }
    
    if (enableBackend && backendUrl) {
      if (debugMode) {
        core.info(`🔄 Starting backend monitoring process...`);
      }
    } else {
      if (debugMode) {
        core.info(`🔄 Starting local monitoring process...`);
      }
    }

    // Start monitoring process in background
    const env = {
      ...process.env,
      RUN_ID: runId,
      LOG_FILE: logFilePath,
      DEBUG_MODE: debugMode.toString(),
      REMOTE_MONITORING: (enableBackend && backendUrl) ? 'true' : 'false',
      EXPORT_TO_BIGQUERY: exportToBigquery ? 'true' : 'false',
      COLLECT_GC: 'true'
    };

    const child = spawn(scriptPath, args, {
      cwd: path.join(actionDir, '..'),  // Run in the repository root, not dist/
      env: env,
      detached: true,
      stdio: 'inherit'
    });

    // Store the PID for cleanup
    const pid = child.pid;
    if (debugMode) {
      core.info(`🔄 Monitoring process started with PID: ${pid}`);
    }
    
    // Add error handling
    child.on('error', (error) => {
      core.error(`❌ Failed to start monitoring process: ${error.message}`);
      core.setFailed(`Monitor script failed to start: ${error.message}`);
    });

    child.on('exit', (code, signal) => {
      if (code !== 0) {
        core.error(`❌ Monitoring process exited with code ${code} and signal ${signal}`);
      } else {
        core.info(`✅ Monitoring process completed successfully`);
      }
    });
    
    // Don't wait for the process to complete - let it run in background
    child.unref();

    if (enableBackend && backendUrl) {
      if (debugMode) {
        core.info('✅ Backend monitoring started in background');
        core.info(`📈 Check your dashboard for run ID: ${runId}`);
        core.info(`🔄 Monitoring will continue until the job completes`);
        core.info(`🔄 Note: If remote monitoring connection fails, monitoring will fall back to local mode`);
      } else {
        core.info(`🔄 Note: If remote monitoring connection fails, monitoring will fall back to local mode`);
      }
    } else {
      if (debugMode) {
        core.info('✅ Local monitoring started in background');
        core.info(`📁 Check log file: ${logFilePath}`);
        core.info(`🔄 Monitoring will continue until the job completes`);
      }
    }

  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed('Unknown error occurred');
    }
  }
}

run();