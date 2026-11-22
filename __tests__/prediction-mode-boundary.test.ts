import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

test.each(['forecast', 'predict', 'bqml-boosted', 'tabpfn', 'disabled'])('monitor sends the %s request to the backend', (mode) => {
  const script = fs.readFileSync(path.join(__dirname, '../monitor_with_backend.sh'), 'utf8');
  const authFunction = script.slice(script.indexOf('get_auth_token() {'), script.indexOf('# Function to get VM flags'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpw-mode-test-'));
  try {
    const capture = path.join(dir, 'request');
    const shell = `
      log_script() { :; }
      curl() { printf '%s\\n' "$@" > "$CAPTURE"; printf '{"token":"test","expires_at":"later"}\\nHTTP_CODE:200\\nTIME_TOTAL:0\\nTIME_CONNECT:0\\n'; }
      ${authFunction}
      get_auth_token
    `;
    execFileSync('bash', ['-c', shell], { env: {
      ...process.env, CAPTURE: capture, BACKEND_DEBUG_LOG: path.join(dir, 'debug'),
      BACKEND_URL: 'https://example.test', RUN_ID: 'run-1', DEBUG_MODE: 'false',
      CURL_TIMEOUT: '5', CURL_CONNECT_TIMEOUT: '5', PREDICTION_MODE: mode,
      PREDICTION_THROTTLE_S: '20',
      PREDICTION_TARGET: mode === 'tabpfn' ? 'class_loading' : 'memory',
      EXPORT_TO_BIGQUERY: 'false',
    } });
    const request = fs.readFileSync(capture, 'utf8');
    if (mode === 'disabled') expect(request).not.toContain('prediction_mode=');
    else expect(request).toContain(`prediction_mode=${mode}`);
    expect(request).toContain('prediction_throttle_s=20');
    expect(request).toContain(`prediction_target=${mode === 'tabpfn' ? 'class_loading' : 'memory'}`);
      } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
