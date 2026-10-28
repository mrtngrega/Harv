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
    expect(extOf('image/jpeg')).toBe('.jpg');
    expect(extOf('image/webp')).toBe('.webp');
    expect(extOf('image/png')).toBe('.png');
  });

  it('is one of Harv’s own tools for the gate (the user asked for the picture)', () => {
    expect(classify('mcp__harv__generate_image', { prompt: 'a cat' }).tier).toBe('green');
  });
});
