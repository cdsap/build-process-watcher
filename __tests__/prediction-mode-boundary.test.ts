import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

test.each(['reliability', 'forecast', 'predict', 'disabled'])('monitor sends the %s request to the backend', (mode) => {
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
      PREDICTIVE_RELIABILITY: mode === 'reliability' ? 'true' : 'false', EXPORT_TO_BIGQUERY: 'false',
    } });
    const request = fs.readFileSync(capture, 'utf8');
    if (mode === 'disabled') expect(request).not.toContain('prediction_mode=');
    else expect(request).toContain(`prediction_mode=${mode}`);
    expect(request.includes('predictive_reliability=true')).toBe(mode === 'reliability');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
