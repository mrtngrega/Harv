import { describe, expect, it } from 'vitest';
import { isPicture, pathsIn, previewKind } from './preview.ts';
import { parseCommand } from './commands.ts';

describe('files a reply names (docs/PLAN.md §6s B2, B3)', () => {
  it('finds full paths in code, in links and bare, each once', () => {
    const text = [
      'Saved it to `C:\\My files\\Code\\car_radio\\design\\front.png` and the page is C:\\Users\\m\\page.html.',
      'Also [the report](C:/Users/m/Documents/report.docx), and `C:\\My files\\Code\\car_radio\\design\\front.png` again.',
      'On the notebook: /home/martin/Pictures/shot.webp',
    ].join('\n');
    expect(pathsIn(text)).toEqual([
      'C:\\My files\\Code\\car_radio\\design\\front.png',
      'C:/Users/m/Documents/report.docx',
      'C:\\Users\\m\\page.html',
      '/home/martin/Pictures/shot.webp',
    ]);
  });

  it('leaves out folders, relative paths, URLs and code blocks', () => {
    expect(pathsIn('In `C:\\My files\\Code` run `npm test`, see src/index.ts or https://x.com/a.png')).toEqual([]);
    expect(pathsIn('```\ncat C:\\x\\secret.txt\n```')).toEqual([]);
  });

  it('knows what the pane can show', () => {
    expect(previewKind('C:\\a\\b.HTML')).toBe('html');
    expect(previewKind('/tmp/d.mmd')).toBe('mermaid');
    expect(previewKind('C:\\a\\b.docx')).toBeUndefined();
    expect(isPicture('C:\\a\\b.svg')).toBe(true);
    expect(isPicture('C:\\a\\b.pdf')).toBe(false);
  });
});

describe('/plan and /rewind', () => {
  it('toggles or sets plan mode, and leaves sentences alone', () => {
    expect(parseCommand('/plan')).toEqual({ kind: 'plan' });
    expect(parseCommand('/plan on')).toEqual({ kind: 'plan', on: true });
    expect(parseCommand('/plan OFF')).toEqual({ kind: 'plan', on: false });
    expect(parseCommand('/plan the next release')).toBeNull();
    expect(parseCommand('/rewind')).toEqual({ kind: 'rewind' });
    expect(parseCommand('/rewind to yesterday')).toBeNull();
  });
});
