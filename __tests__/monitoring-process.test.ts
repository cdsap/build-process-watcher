import * as childProcess from 'child_process';
import {
  createMonitoringProcessLaunchPlan,
  startMonitoringProcess,
} from '../src/monitoring_process';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

const inputs = {
  actionDir: '/actions/dist',
  interval: '5',
  backendUrl: 'https://backend.example',
  runId: 'run-1',
  logFilePath: '/tmp/run-1.log',
  defaultLogFile: false,
  debugMode: true,
  exportToBigquery: true,
  predictiveReliability: true,
  enableBackend: true,
};

describe('createMonitoringProcessLaunchPlan', () => {
  it('creates a local launch plan with the interval-only argument and monitor environment', () => {
    const plan = createMonitoringProcessLaunchPlan(
      { ...inputs, backendUrl: '', enableBackend: false },
      { PATH: '/bin', EXISTING: 'value' }
    );

    expect(plan).toMatchObject({
      scriptPath: '/actions/monitor_with_backend.sh',
      command: '/actions/monitor_with_backend.sh',
      args: ['5'],
      cwd: '/actions',
      detached: true,
      stdio: 'inherit',
      env: {
        PATH: '/bin',
        EXISTING: 'value',
        RUN_ID: 'run-1',
        LOG_FILE: '/tmp/run-1.log',
        BPW_LOG_FILE_DEFAULT: 'false',
        DEBUG_MODE: 'true',
        REMOTE_MONITORING: 'false',
        EXPORT_TO_BIGQUERY: 'true',
        PREDICTIVE_RELIABILITY: 'true',
        COLLECT_GC: 'true',
      },
    });
  });

  it('creates a remote launch plan with backend URL and run ID arguments', () => {
    const plan = createMonitoringProcessLaunchPlan(inputs, { PATH: '/bin' });

    expect(plan).toMatchObject({
      scriptPath: '/actions/monitor_with_backend.sh',
      command: '/actions/monitor_with_backend.sh',
      args: ['5', 'https://backend.example', 'run-1'],
      cwd: '/actions',
      detached: true,
      stdio: 'inherit',
      env: {
        PATH: '/bin',
        RUN_ID: 'run-1',
        LOG_FILE: '/tmp/run-1.log',
        BPW_LOG_FILE_DEFAULT: 'false',
        DEBUG_MODE: 'true',
        REMOTE_MONITORING: 'true',
        EXPORT_TO_BIGQUERY: 'true',
        PREDICTIVE_RELIABILITY: 'true',
        COLLECT_GC: 'true',
      },
    });
  });

  it('starts the process with the launch plan and unrefs it', () => {
    const child = {
      pid: 123,
      on: jest.fn(),
      unref: jest.fn(),
    } as unknown as childProcess.ChildProcess;
    const spawn = childProcess.spawn as jest.MockedFunction<typeof childProcess.spawn>;
    spawn.mockReturnValue(child);
    const plan = createMonitoringProcessLaunchPlan(inputs, { PATH: '/bin' });

    expect(startMonitoringProcess(plan, false)).toBe(child);
    expect(spawn).toHaveBeenCalledWith(plan.command, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      detached: true,
      stdio: 'inherit',
    });
    expect(child.unref).toHaveBeenCalledTimes(1);
  });
});
