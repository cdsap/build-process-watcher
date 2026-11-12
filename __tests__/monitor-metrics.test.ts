import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

function parserFunction(): string {
  const script = fs.readFileSync(path.join(__dirname, '../monitor_with_backend.sh'), 'utf8');
  const match = script.match(/jstat_named_values\(\) \{[\s\S]*?\n\}/);
  if (!match) throw new Error('jstat_named_values function not found');
  return match[0];
}

function freshnessFunction(): string {
  const script = fs.readFileSync(path.join(__dirname, '../monitor_with_backend.sh'), 'utf8');
  const match = script.match(/freshness_json_fragment\(\) \{[\s\S]*?\n\}/);
  if (!match) throw new Error('freshness_json_fragment function not found');
  return match[0];
}

function runParser(fixture: string, columns: string): string {
  const bash = `${parserFunction()}\n` +
    `jstat() { printf '%s\\n' "$JSTAT_FIXTURE"; }\n` +
    `jstat_named_values -compiler 123 ${columns}`;
  return execFileSync('bash', ['-c', bash], {
    encoding: 'utf8',
    env: { ...process.env, JSTAT_FIXTURE: fixture },
  });
}

describe('jstat_named_values', () => {
  it('matches values by header name when columns are reordered or added', () => {
    const output = runParser('Extra Time Invalid Compiled Failed\n9 1.25 2 44 3', 'Compiled Failed Invalid Time');
    expect(output).toBe('44|3|2|1.25');
  });

  it('returns N/A for a missing header without losing other values', () => {
    const output = runParser('Compiled Time\n12 0.50', 'Compiled Failed Time');
    expect(output).toBe('12|N/A|0.50');
  });
});

describe('freshness_json_fragment', () => {
  it('emits opt-in per-sample timing metadata', () => {
    const bash = `${freshnessFunction()}\n` +
      'FRESHNESS_DIAGNOSTICS=true freshness_json_fragment 7-12345 7 1700000000123';
    const output = execFileSync('bash', ['-c', bash], { encoding: 'utf8' });
    expect(JSON.parse(`{${output}}`)).toEqual({
      freshness: {
        sample_id: '7-12345',
        sequence: 7,
        collected_at_unix_ms: 1700000000123,
      },
    });
  });

  it('emits nothing when diagnostics are disabled', () => {
    const bash = `${freshnessFunction()}\n` +
      'FRESHNESS_DIAGNOSTICS=false freshness_json_fragment 7-12345 7 1700000000123';
    expect(execFileSync('bash', ['-c', bash], { encoding: 'utf8' })).toBe('');
  });

  it('omits incomplete timing metadata instead of producing invalid JSON', () => {
    const bash = `${freshnessFunction()}\n` +
      "FRESHNESS_DIAGNOSTICS=true freshness_json_fragment '' 7 1700000000123";
    expect(execFileSync('bash', ['-c', bash], { encoding: 'utf8' })).toBe('');
  });
});
