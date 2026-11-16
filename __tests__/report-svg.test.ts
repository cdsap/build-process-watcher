import {
  median,
  buildForwardFilledSeries,
  buildPathFromSeries,
  lightenHexColor,
  escapeSvgText,
  lastNonNull,
} from '../src/lib/report_svg';

describe('report_svg helpers', () => {
  it('computes median', () => {
    expect(median([])).toBe(0);
    expect(median([1, 3, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('forward-fills within the max gap', () => {
    const timestamps = ['a', 'b', 'c'];
    const seconds = [0, 1, 10];
    const values = new Map([['a', 5]]);
    expect(buildForwardFilledSeries(timestamps, seconds, values, 2)).toEqual([5, 5, null]);
  });

  it('builds discontinuous SVG paths', () => {
    expect(buildPathFromSeries([1, null, 2], 10, 1, 100, { bottom: 10, left: 5 })).toBe('M 5 89M 25 88');
  });

  it('lightens hex colors and escapes SVG text', () => {
    expect(lightenHexColor('#000000', 16)).toBe('#101010');
    expect(escapeSvgText('a<b>&"c"')).toContain('&lt;');
    expect(lastNonNull([null, 1, null, 4, null])).toBe(4);
  });
});
