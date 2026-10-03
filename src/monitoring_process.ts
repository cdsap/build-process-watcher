import * as core from '@actions/core';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import {
  resolveMonitorSpawnInvocation,
} from './monitor_spawn';

const MONITORING_SCRIPT = 'monitor_with_backend.sh';

export interface MonitoringProcessLaunchPlan {
  scriptPath: string;
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  detached: true;
  stdio: 'inherit';
}

export interface MonitoringProcessLaunchInputs {
  actionDir: string;
  interval: string;
  backendUrl: string;
  runId: string;
  logFilePath: string;
  defaultLogFile: boolean;
  debugMode: boolean;
  exportToBigquery: boolean;
  predictiveReliability: boolean;
  enableBackend: boolean;
}

export function createMonitoringProcessLaunchPlan(
  inputs: MonitoringProcessLaunchInputs,
  environment: NodeJS.ProcessEnv = process.env
): MonitoringProcessLaunchPlan {
  const scriptPath = path.join(inputs.actionDir, '..', MONITORING_SCRIPT);
  const monitorArgs = inputs.enableBackend && inputs.backendUrl
    ? [inputs.interval, inputs.backendUrl, inputs.runId]
    : [inputs.interval];
  const { command, args } = resolveMonitorSpawnInvocation(scriptPath, monitorArgs);

  return {
    scriptPath,
    command,
    args,
    cwd: path.join(inputs.actionDir, '..'),
    env: {
      ...environment,
      RUN_ID: inputs.runId,
      LOG_FILE: inputs.logFilePath,
      BPW_LOG_FILE_DEFAULT: inputs.defaultLogFile.toString(),
      DEBUG_MODE: inputs.debugMode.toString(),
      REMOTE_MONITORING: inputs.enableBackend && inputs.backendUrl ? 'true' : 'false',
      EXPORT_TO_BIGQUERY: inputs.exportToBigquery ? 'true' : 'false',
      PREDICTIVE_RELIABILITY: inputs.predictiveReliability ? 'true' : 'false',
      COLLECT_GC: 'true',
    },
    detached: true,
    stdio: 'inherit',
  };
}

export function startMonitoringProcess(
  plan: MonitoringProcessLaunchPlan,
  debugMode: boolean
): ChildProcess {
  const child = spawn(plan.command, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    detached: plan.detached,
    stdio: plan.stdio,
  });

  if (debugMode) {
    core.info(`🔄 Monitoring process started with PID: ${child.pid}`);
  }

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

  child.unref();
  return child;
}
