import { describe, expect, it } from 'vitest';
import { classify } from '../safety/classify.ts';
import { extOf, imageFileName } from './gemini.ts';

describe('pictures from Gemini', () => {
  const at = new Date(2026, 9, 28, 19, 5);

  it('names a picture by time and what it shows', () => {
    expect(imageFileName('A red apple on a wooden table, soft light', at)).toBe(
      '2026-10-28-1905-a-red-apple-on-a-wooden-table-soft-light.png',
    );
    expect(imageFileName('Žltý kôň pri jazere', at, '.jpg')).toBe('2026-10-28-1905-zlty-kon-pri-jazere.jpg');
    expect(imageFileName('!!!', at)).toBe('2026-10-28-1905-image.png');
    expect(imageFileName('cat', at, '.png', 1)).toBe('2026-10-28-1905-cat-2.png');
    // The time, at most 40 characters of words, the extension.
    expect(imageFileName('x'.repeat(100), at)).toBe(`2026-10-28-1905-${'x'.repeat(40)}.png`);
  });

  it('keeps the picture’s own type', () => {
    expect(extOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]))).toBe('.jpg');
    expect(extOf(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'))).toBe('.webp');
    expect(extOf(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('.png');
  });

  it('is one of Harv’s own tools for the gate (the user asked for the picture)', () => {
    expect(classify('mcp__harv__generate_image', { prompt: 'a cat' }).tier).toBe('green');
  });
});
