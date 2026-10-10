import * as fs from 'fs';
import * as path from 'path';

describe('build story phase selection', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../frontend/public/build-story.js'),
    'utf8',
  );

  it('keeps the clicked phase selected when its start overlaps another phase', () => {
    const handler = source.match(
      /button\.addEventListener\('click', \(\) => \{([\s\S]*?)\n\s*\}\);/,
    )?.[1] || '';

    const frameSelection = handler.indexOf('selectUnifiedFrame?.(phase.start)');
    const phaseSelection = handler.indexOf('selectPhase(phase.id)');
    expect(frameSelection).toBeGreaterThan(-1);
    expect(phaseSelection).toBeGreaterThan(-1);
    expect(frameSelection).toBeLessThan(phaseSelection);
  });
});
