import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'harv-attach-'));
vi.stubEnv('HARV_HOME', home);
const { attachmentPath, buildContent, cleanAttachments, deleteAttachments, mimeOf, safeName, saveAttachment } =
  await import('./attachments.ts');

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('attachments', () => {
  it('cleans file names so they stay inside their folder', () => {
    expect(safeName(String.raw`..\..\Windows\evil.txt`)).toBe('evil.txt');
    expect(safeName('a<b>:c?.pdf')).toBe('a_b__c_.pdf');
    expect(safeName('...')).toBe('file');
  });

  it('rejects ids and tabs that could escape the attachments folder', () => {
    expect(attachmentPath('../x', { id: '00000000-0000-0000-0000-000000000000', name: 'a' })).toBeNull();
    expect(attachmentPath('tab', { id: '../../etc', name: 'a' })).toBeNull();
  });

  it('detects images, PDFs and text by extension', () => {
    expect(mimeOf('Shot.PNG')).toBe('image/png');
    expect(mimeOf('report.pdf')).toBe('application/pdf');
    expect(mimeOf('notes.md')).toBe('text/plain');
    expect(mimeOf('setup.exe')).toBe('application/octet-stream');
  });

  it('inlines small files and points Claude at the saved path', () => {
    const png = saveAttachment('tab-1', 'shot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const txt = saveAttachment('tab-1', 'notes.txt', Buffer.from('hello'));
    const bin = saveAttachment('tab-1', 'tool.exe', Buffer.from([0]));
    const blocks = buildContent('tab-1', 'what is this?', [png, txt, bin]);

    expect(blocks.map((b) => b.type)).toEqual(['image', 'text', 'text']);
    expect(blocks[1]).toMatchObject({ text: '<file name="notes.txt">\nhello\n</file>' });
    const note = (blocks[2] as { text: string }).text;
    expect(note).toMatch(/^what is this\?/);
    expect(note).toContain(attachmentPath('tab-1', bin)!);
    expect(note).toContain('tool.exe');
    expect(note).toMatch(/tool\.exe .*open it with Read/);

    deleteAttachments('tab-1');
    expect(buildContent('tab-1', '', [png])[0]).toMatchObject({ type: 'text' });
  });
});

describe('files and folders referenced where they are (nothing uploaded)', () => {
  const dir = join(home, 'given');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'notes.md');
  writeFileSync(file, '# hi');

  it('checks each reference against the disk: name, size and kind come from there, not from the dashboard', () => {
    const [folder, doc] = cleanAttachments([
      { id: 'x', name: 'lies', size: 999, mime: 'image/png', path: dir, folder: false },
      { id: '', name: 'notes.md', size: 0, mime: '', path: file },
    ]);
    expect(folder).toMatchObject({ path: dir, folder: true, size: 0, name: 'given' });
    expect(doc).toMatchObject({ path: file, folder: false, size: 4, mime: 'text/plain' });
  });

  it('drops paths that aren’t absolute paths of this OS, and keeps uploads as they are', () => {
    const upload = { id: '00000000-0000-0000-0000-000000000000', name: 'a.png', size: 1, mime: 'image/png' };
    expect(cleanAttachments([{ id: '', name: 'x', size: 0, mime: '', path: 'relative/x' }, upload])).toEqual([upload]);
  });

  it('tells Harv where they are instead of inlining them, and says they need no approval', () => {
    const blocks = buildContent('tab-ref', 'tidy this up', cleanAttachments([{ id: '', name: '', size: 0, mime: '', path: dir }]));
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('tidy this up');
    expect(text).toContain(`- ${dir} (folder)`);
    expect(text).toMatch(/doesn.t ask for approval/);
    expect(text).not.toContain('saved in your workspace');
  });

  it('notes a referenced path that is gone', () => {
    const gone = join(home, 'gone.txt');
    const text = (buildContent('tab-ref', '', [{ id: '', name: 'gone.txt', size: 0, mime: '', path: gone }])[0] as { text: string }).text;
    expect(text).toContain('not found on this PC right now');
  });
});
