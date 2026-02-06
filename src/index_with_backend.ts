import * as core from '@actions/core';
import * as exec from '@actions/exec';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

async function run() {
  try {
    let backendUrl = core.getInput('backend_url');
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
    // collect_gc defaults to 'true' - only disable if explicitly set to 'false'
    const collectGcInput = core.getInput('collect_gc');
    const collectGc = collectGcInput === '' || collectGcInput === 'true';
    const disableSummaryOutput = core.getInput('disable_summary_output') === 'true';
    const environment = core.getInput('environment') || 'production'; // Default to production

    // If backend is enabled but no URL provided, use the default Cloud Run URL based on environment
    if (enableBackend && !backendUrl) {
      if (environment === 'staging') {
        // Default staging backend URL (users should update this to their actual staging URL)
        backendUrl = 'https://build-process-watcher-backend-staging-685615422311.us-central1.run.app';
      } else {
        // Default production backend URL
        backendUrl = 'https://build-process-watcher-backend-685615422311.us-central1.run.app';
      }
      if (debugMode) {
        core.info(`🔧 Backend enabled but no URL provided, using default ${environment} URL: ${backendUrl}`);
      }
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
      // Determine if we're in staging mode
      const isStaging = environment === 'staging' || backendUrl.includes('-staging');
      
      // Check for frontend URL from environment variables first, then input
      // This allows workflows to set FRONTEND_URL_STAGING or FRONTEND_URL as env vars
      const envFrontendUrl = isStaging 
        ? process.env.FRONTEND_URL_STAGING || process.env.FRONTEND_URL
        : process.env.FRONTEND_URL;
      
      // Check explicit frontend URL: env vars first, then input parameter
      const explicitFrontendUrl = envFrontendUrl || core.getInput('frontend_url');
      
      if (explicitFrontendUrl) {
        // Use explicitly provided frontend URL (from env var or input)
        if (explicitFrontendUrl.endsWith('/runs') || explicitFrontendUrl.endsWith('/runs/')) {
          frontendUrl = `${explicitFrontendUrl}/${runId}`;
        } else {
          frontendUrl = `${explicitFrontendUrl}/runs/${runId}`;
        }
        
        if (debugMode && envFrontendUrl) {
          core.info(`🌐 Using frontend URL from environment variable: ${envFrontendUrl}`);
        }
      } else {
        // Derive frontend URL from backend URL pattern or environment
        // Production: build-process-watcher-backend -> process-watcher.web.app
        // Staging: build-process-watcher-backend-staging -> build-process-watcher-staging.web.app
        let baseFrontendUrl = 'https://process-watcher.web.app';
        
        if (isStaging) {
          // Staging backend - use default staging frontend URL
          // User should provide frontend_url or FRONTEND_URL_STAGING for custom URLs
          baseFrontendUrl = 'https://build-process-watcher-staging.web.app';
          
          if (debugMode) {
            core.info(`🔧 Staging mode detected - using default staging frontend URL`);
            core.info(`💡 Tip: Set FRONTEND_URL_STAGING env var or provide frontend_url input for custom staging URL`);
          }
        }
        
        frontendUrl = `${baseFrontendUrl}/runs/${runId}`;
      }
      
      if (debugMode) {
        core.info(`🌐 Frontend URL: ${frontendUrl}`);
      }
    }

    // Export variables for the cleanup step
    core.exportVariable('ENABLE_BACKEND', enableBackend.toString());
    core.exportVariable('BACKEND_URL', backendUrl || '');
    core.exportVariable('RUN_ID', runId);
    core.exportVariable('LOG_FILE', logFilePath);
    core.exportVariable('ENVIRONMENT', environment);
    core.exportVariable('DISABLE_SUMMARY_OUTPUT', disableSummaryOutput.toString());
    
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
    if (frontendUrl) {
      // Extract base URL (without /runs/runId) for cleanup step
      const baseFrontendUrl = frontendUrl.replace(/\/runs\/.*$/, '');
      core.exportVariable('FRONTEND_URL', baseFrontendUrl);
    }

    // Set output for use in other steps
    core.setOutput('run_id', runId);
    core.setOutput('backend_url', backendUrl || '');
    core.setOutput('remote_monitoring', enableBackend.toString());
    core.setOutput('frontend_url', frontendUrl);

    if (enableBackend && !backendUrl) {
      core.warning('⚠️  Remote monitoring is enabled but no backend_url provided and default URL not available.');
    }

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
      BACKEND_URL: backendUrl,
      RUN_ID: runId,
      LOG_FILE: logFilePath,
      DEBUG_MODE: debugMode.toString(),
      REMOTE_MONITORING: (enableBackend && backendUrl) ? 'true' : 'false',
      COLLECT_GC: collectGc.toString()
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