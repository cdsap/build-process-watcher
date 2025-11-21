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
    const logFile = core.getInput('log_file') || 'build_process_watcher.log';
    const debugMode = core.getInput('debug') === 'true';

    // If backend is enabled but no URL provided, use the default Cloud Run URL
    if (enableBackend && !backendUrl) {
      backendUrl = 'https://build-process-watcher-backend-685615422311.us-central1.run.app';
      if (debugMode) {
        core.info(`🔧 Backend enabled but no URL provided, using default: ${backendUrl}`);
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
      // Check for frontend URL from environment variables first, then input
      // This allows workflows to set FRONTEND_URL or FRONTEND_URL_STAGING as env vars
      const isStaging = backendUrl.includes('-staging');
      const envFrontendUrl = isStaging 
        ? process.env.FRONTEND_URL_STAGING || process.env.FRONTEND_URL
        : process.env.FRONTEND_URL;
      
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
        // Derive frontend URL from backend URL pattern
        // For staging, frontend_url should be provided explicitly since we can't derive it
        if (isStaging) {
          // For staging, we can't auto-detect the frontend URL reliably
          // Use production as fallback but warn the user
          core.warning('⚠️  Staging backend detected but no frontend_url provided.');
          core.warning('💡 Set FRONTEND_URL_STAGING or FRONTEND_URL environment variable, or provide frontend_url input');
          core.warning('💡 Example: https://process-watcher-staging-c5bd6.web.app');
          core.warning('⚠️  Dashboard URL will point to production. Provide frontend_url for correct staging links.');
        }
        
        // Use production frontend as fallback (user should provide frontend_url for staging)
        const baseFrontendUrl = 'https://process-watcher.web.app';
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
    core.exportVariable('LOG_FILE', logFile);
    if (frontendUrl) {
      // Export base frontend URL (without /runs/runId) for cleanup step
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
        core.info(`📝 LOCAL LOGGING MODE - Data will be saved to: ${logFile}`);
      }
    }

    // Execute the monitoring script
    const args = enableBackend && backendUrl 
      ? ['5', backendUrl, runId]  // interval, backend_url, run_id
      : [logFile];

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
      LOG_FILE: logFile,
      DEBUG_MODE: debugMode.toString(),
      REMOTE_MONITORING: (enableBackend && backendUrl) ? 'true' : 'false'
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
        core.info(`📁 Check log file: ${logFile}`);
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