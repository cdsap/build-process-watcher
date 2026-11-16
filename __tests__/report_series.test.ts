import {
  buildForwardFilledSeries,
  buildPathFromSeries,
  lastNonNull,
  median,
} from '../src/lib/report_series';

describe('median', () => {
  it('returns 0 for an empty list', () => {
    expect(median([])).toBe(0);
  });

  it('returns the middle value for odd-length lists', () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it('averages the two middle values for even-length lists', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe('buildForwardFilledSeries', () => {
  const timestamps = ['00:00:00', '00:00:05', '00:00:10', '00:00:20'];
  const timestampSeconds = [0, 5, 10, 20];

  it('fills gaps within the max gap and clears after larger gaps', () => {
    const valuesByTimestamp = new Map<string, number>([
      ['00:00:00', 10],
      ['00:00:10', 30],
    ]);

    expect(
      buildForwardFilledSeries(timestamps, timestampSeconds, valuesByTimestamp, 6)
    ).toEqual([10, 10, 30, null]);
  });

  it('keeps leading nulls until the first observed value', () => {
    const valuesByTimestamp = new Map<string, number>([['00:00:10', 7]]);

    expect(
      buildForwardFilledSeries(timestamps, timestampSeconds, valuesByTimestamp, 10)
    ).toEqual([null, null, 7, 7]);
  });
});

describe('buildPathFromSeries', () => {
  it('builds a path and breaks on null gaps', () => {
    const path = buildPathFromSeries(
      [10, null, 20],
      10,
      2,
      100,
      { left: 5, bottom: 10 }
    );

    expect(path).toBe('M 5 70M 25 50');
  });

  it('returns an empty string when every value is null', () => {
    expect(buildPathFromSeries([null, null], 1, 1, 100, { left: 0, bottom: 0 })).toBe('');
  });
});

describe('lastNonNull', () => {
  it('returns the last finite-or-null non-null entry', () => {
    expect(lastNonNull([1, null, 3, null])).toBe(3);
    expect(lastNonNull([null, null])).toBeNull();
    expect(lastNonNull([])).toBeNull();
  });
});
