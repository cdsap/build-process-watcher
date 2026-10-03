import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  DEFAULT_LOG_FILE_NAME,
  resolveActionRuntimeStatePaths,
  resolveActionLogFileTarget,
} from './action_config';
import {
  resolveMonitoringFeatureFlags,
} from './monitoring_features';
import {
  shouldMakeScriptExecutable,
} from './monitor_spawn';
import {
  createMonitoringProcessLaunchPlan,
  startMonitoringProcess,
} from './monitoring_process';

async function run() {
  try {
    const requestedBackendUrl = process.env.BACKEND_URL || '';
    const requestedFrontendUrl = process.env.FRONTEND_URL || '';
    const remoteMonitoringRequested = core.getInput('remote_monitoring') === 'true';
    const runId = core.getInput('run_id') || `run-${Date.now()}`;
    const debugMode = core.getInput('debug') === 'true';
    const logFileInput = core.getInput('log_file') || DEFAULT_LOG_FILE_NAME;
    const workspaceDir = process.env.GITHUB_WORKSPACE;
    const runnerTempRoot = process.env.RUNNER_TEMP || os.tmpdir();
    const runtimeStatePaths = resolveActionRuntimeStatePaths({ runnerTempRoot, runId });
    const defaultLogPath = path.join(runtimeStatePaths.runnerTempDir, DEFAULT_LOG_FILE_NAME);
    const defaultLogPathExists =
      logFileInput === DEFAULT_LOG_FILE_NAME && fs.existsSync(defaultLogPath);
    const {
      runnerTempDir,
      logFilePath,
      defaultLogFile,
      collisionFallbackUsed,
    } = resolveActionLogFileTarget({
      runId,
      logFileInput,
      workspaceDir,
      runnerTempRoot,
      defaultLogPathExists,
    });
    fs.mkdirSync(runnerTempDir, { recursive: true });
    if (debugMode && collisionFallbackUsed) {
      core.info(`🧭 Log file already exists, using: ${logFilePath}`);
    }
    const interval = core.getInput('interval') || '5';
    const disableSummaryOutput = core.getInput('disable_summary_output') === 'true';
    const exportToBigqueryRequested = core.getInput('export_to_bigquery') === 'true';
    const predictiveReliabilityRequested = core.getInput('predictive_reliability') === 'true';

    const {
      enableBackend,
      backendUrl,
      frontendUrl,
      exportToBigquery,
      predictiveReliability,
    } = resolveMonitoringFeatureFlags({
      remoteMonitoringRequested,
      exportToBigqueryRequested,
      predictiveReliabilityRequested,
      backendUrl: requestedBackendUrl,
      frontendUrl: requestedFrontendUrl,
      runId,
    });
    const useBackend = enableBackend && !!backendUrl;

    if (enableBackend && !requestedBackendUrl && debugMode) {
      core.info(`🔧 Backend enabled but no URL provided, using default URL: ${backendUrl}`);
    }

    if (predictiveReliabilityRequested && debugMode) {
      core.info(`🔮 predictive_reliability enables remote_monitoring and export_to_bigquery for this run`);
    } else if (exportToBigqueryRequested && !useBackend && debugMode) {
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
      if (frontendUrl) {
        core.info(`🌐 Frontend URL: ${frontendUrl}`);
      }
    }

    // Export variables for the cleanup step
    core.exportVariable('ENABLE_BACKEND', enableBackend.toString());
    core.exportVariable('RUN_ID', runId);
    core.exportVariable('LOG_FILE', logFilePath);
    core.exportVariable('BPW_LOG_FILE_DEFAULT', defaultLogFile.toString());
    core.exportVariable('DISABLE_SUMMARY_OUTPUT', disableSummaryOutput.toString());
    core.exportVariable('EXPORT_TO_BIGQUERY', exportToBigquery ? 'true' : 'false');
    core.exportVariable('PREDICTIVE_RELIABILITY', predictiveReliability ? 'true' : 'false');
    
    // Also write RUN_ID to a file as a backup for the post step
    // This ensures the post step can always find the RUN_ID even if env vars aren't available
    try {
      const runIdFile = runtimeStatePaths.runIdFile;
      fs.writeFileSync(runIdFile, runId, 'utf8');
      if (debugMode) {
        core.info(`💾 Saved RUN_ID to file: ${runIdFile}`);
      }
    } catch (error) {
      // Non-critical - env var export should be sufficient
      if (debugMode) {
        core.warning(`⚠️  Failed to write RUN_ID to file: ${error}`);
      }
    }
    if (frontendUrl || backendUrl) {
      try {
        if (backendUrl) {
          fs.writeFileSync(runtimeStatePaths.backendUrlFile, backendUrl, 'utf8');
        }
        if (frontendUrl) {
          const baseFrontendUrl = frontendUrl.replace(/\/runs\/.*$/, '');
          fs.writeFileSync(runtimeStatePaths.frontendUrlFile, baseFrontendUrl, 'utf8');
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
    core.setOutput('predictive_reliability', predictiveReliability.toString());

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

    const actionDir = __dirname;
    const launchPlan = createMonitoringProcessLaunchPlan({
      actionDir,
      interval,
      backendUrl,
      runId,
      logFilePath,
      defaultLogFile,
      debugMode,
      exportToBigquery,
      predictiveReliability,
      enableBackend,
    });
    const scriptPath = launchPlan.scriptPath;
    
    // Check if script exists
    if (!fs.existsSync(scriptPath)) {
      core.setFailed(`❌ Monitor script not found: ${scriptPath}`);
      return;
    }
    
    // Make the script executable on POSIX; Windows launches via bash instead
    if (shouldMakeScriptExecutable()) {
      try {
        await exec.exec('chmod', ['+x', scriptPath]);
        if (debugMode) {
          core.info(`✅ Made script executable: ${scriptPath}`);
        }
      } catch (error) {
        core.warning(`⚠️  Could not make script executable: ${error}`);
      }
    }

    if (debugMode) {
      core.info(`▶️  Executing: ${launchPlan.command} ${launchPlan.args.join(' ')}`);
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

    startMonitoringProcess(launchPlan, debugMode);

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
