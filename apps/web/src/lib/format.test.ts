import { describe, expect, it } from 'vitest';
import { countDuplicates, duration, rate, sizePair } from './format.ts';

describe('format', () => {
  it('formats throughput', () => {
    expect(rate(205)).toBe('205 B/s');
    expect(rate(17.7 * 1024)).toBe('18 KB/s');
    expect(rate(1.6 * 1024 ** 2)).toBe('1.6 MB/s');
    expect(rate(undefined)).toBe('—');
  });

  it('puts both sides of a size pair in the total unit', () => {
    expect(sizePair(752 * 1024 ** 3, 931 * 1024 ** 3)).toBe('752 / 931 GB');
    expect(sizePair(1.2 * 1024 ** 4, 1.8 * 1024 ** 4)).toBe('1.2 / 1.8 TB');
  });

  it('collapses duplicates', () => {
    expect(countDuplicates(['Kingston 16 GB', 'Kingston 16 GB', 'Other'])).toEqual(['2× Kingston 16 GB', 'Other']);
  });

  it('formats uptime', () => {
    expect(duration(3 * 86400 + 4 * 3600 + 12 * 60)).toBe('3d 4h 12m');
    expect(duration(2 * 3600 + 5 * 60)).toBe('2h 5m');
  });
});
