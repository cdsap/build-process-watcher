import * as fs from 'fs';
import * as path from 'path';

const publicDir = path.join(__dirname, '../frontend/public');
const demoHtml = path.join(publicDir, 'runs/demo.html');
const demoData = path.join(publicDir, 'demo-run.json');

describe('demo dashboard', () => {
  it('uses the current run dashboard with the checked-in real run fixture', () => {
    const html = fs.readFileSync(demoHtml, 'utf8');

    expect(html).toContain("fetch('/demo-run.json')");
    expect(html).toContain('Cumulative JIT Compilation Time');
    expect(html).toContain('Class Loading Activity');
    expect(html).not.toContain('/runs/${runId}');

    const data = JSON.parse(fs.readFileSync(demoData, 'utf8'));
    expect(data.sample_fields).toContain('Timestamp');
    expect(data.sample_fields).toContain('PID');
    expect(data.samples).toHaveLength(730);
    expect(data.samples.every((sample: unknown) => Array.isArray(sample))).toBe(true);
    expect(data.finished).toBe(true);
    expect(Object.keys(data.process_info)).toHaveLength(8);
  });
});
