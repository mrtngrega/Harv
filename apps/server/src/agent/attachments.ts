import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { isReference, type Attachment } from '@harv/shared';
import { HARV_HOME } from '../paths.ts';
import { cleanPath } from '../tools/files.ts';

export type ContentBlockParam = Exclude<SDKUserMessage['message']['content'], string>[number];

// Files the user attaches are saved in Harv's workspace, one folder per file:
// attachments/<tab>/<id>/<name>. Small images, PDFs and text files go to Claude
// inline; everything else (and every file, for later turns) is reachable with Read.
export const ATTACHMENTS_DIR = join(HARV_HOME, 'workspace', 'attachments');

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

const TEXT_EXTENSIONS = new Set(
  '.txt .md .markdown .csv .tsv .json .jsonc .yaml .yml .toml .ini .cfg .conf .log .xml .html .htm .css .scss .js .jsx .ts .tsx .mjs .cjs .py .rs .go .java .kt .c .h .cpp .hpp .cs .rb .php .sh .ps1 .bat .sql .lua .svg'.split(
    ' ',
  ),
);

/** Inline limits; bigger files are left for the Read tool. Claude rejects images over 5 MB. */
const MAX_INLINE_IMAGE = 3.75 * 1024 * 1024;
const MAX_INLINE_PDF = 20 * 1024 * 1024;
const MAX_INLINE_TEXT = 100 * 1024;

const ID = /^[0-9a-f-]{36}$/;
const TAB = /^[\w-]{1,64}$/;

/** A file name that is safe on Windows and can't escape its folder. */
export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const clean = base
    // eslint-disable-next-line no-control-regex -- control characters aren't allowed in Windows file names
    .replace(/[<>:"|?*\x00-\x1f]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(-120);
  return clean || 'file';
}

export function mimeOf(name: string): string {
  const ext = extname(name).toLowerCase();
  return MIME[ext] ?? (TEXT_EXTENSIONS.has(ext) ? 'text/plain' : 'application/octet-stream');
}

export function isValidTab(tabId: string): boolean {
  return TAB.test(tabId);
}

export function attachmentPath(tabId: string, file: Pick<Attachment, 'id' | 'name'>): string | null {
  if (!TAB.test(tabId) || !ID.test(file.id)) return null;
  return join(ATTACHMENTS_DIR, tabId, file.id, safeName(file.name));
}

export function saveAttachment(tabId: string, name: string, data: Buffer): Attachment {
  const file = { id: randomUUID(), name: safeName(name), size: data.length, mime: mimeOf(name) };
  const path = attachmentPath(tabId, file)!;
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, data);
  return file;
}

export function deleteAttachments(tabId: string): void {
  if (TAB.test(tabId)) rmSync(join(ATTACHMENTS_DIR, tabId), { recursive: true, force: true });
}

/**
 * The attachments of a message as the server trusts them: uploads as they are, and each
 * reference (a file or folder on the PC, named by the dashboard) checked: a clean absolute
 * path of this OS, with its name, size and kind read from the disk. Unusable paths are dropped.
 */
export function cleanAttachments(files: Attachment[]): Attachment[] {
  return files.flatMap((f): Attachment[] => {
    if (!isReference(f)) return [f];
    const path = cleanPath(f.path);
    if (!path) return [];
    const st = statSync(path, { throwIfNoEntry: false });
    const folder = st ? st.isDirectory() : f.folder === true;
    return [{ id: '', name: basename(path) || path, size: st && !folder ? st.size : 0, mime: folder ? '' : mimeOf(path), path, folder }];
  });
}

/** A file's inline content block, or null when Claude should open it with Read instead. */
function inlineBlock(path: string, file: Attachment): ContentBlockParam | null {
  const { mime, size } = file;
  if (mime.startsWith('image/') && size <= MAX_INLINE_IMAGE) {
    const media_type = mime as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
    return { type: 'image', source: { type: 'base64', media_type, data: readFileSync(path).toString('base64') } };
  }
  if (mime === 'application/pdf' && size <= MAX_INLINE_PDF) {
    return {
      type: 'document',
      title: file.name,
      source: { type: 'base64', media_type: 'application/pdf', data: readFileSync(path).toString('base64') },
    };
  }
  if (mime === 'text/plain' && size <= MAX_INLINE_TEXT) {
    return { type: 'text', text: `<file name="${file.name}">\n${readFileSync(path, 'utf8')}\n</file>` };
  }
  return null;
}

/**
 * The user's message as content blocks: inline files first, then the text with a note of where
 * each uploaded file is saved and which files and folders on the PC it points at.
 */
export function buildContent(tabId: string, text: string, files: Attachment[]): ContentBlockParam[] {
  const blocks: ContentBlockParam[] = [];
  const notes: string[] = [];
  const refs = files.filter(isReference);
  for (const file of files.filter((f) => !isReference(f))) {
    const path = attachmentPath(tabId, file);
    if (!path || !existsSync(path)) {
      notes.push(`- ${file.name}: the upload is missing, so tell the user to attach it again`);
      continue;
    }
    const block = inlineBlock(path, file);
    if (block) blocks.push(block);
    notes.push(`- ${file.name} (${path})${block ? '' : ': not shown inline, open it with Read if you need it'}`);
  }
  const note = notes.length ? `\n\n[Attached files, saved in your workspace:\n${notes.join('\n')}]` : '';
  // References aren't copied: Harv opens them where they are, with its own tools.
  const where = refs.map(
    (r) => `- ${r.path} (${r.folder ? 'folder' : 'file'}${existsSync(r.path) ? '' : ', not found on this PC right now'})`,
  );
  const refNote = where.length
    ? `\n\n[The user pointed you at these on their PC. They aren't copied: read and work on them where they are. The user gave them to you, so reading them and working inside them doesn't ask for approval (changes and deletes are backed up first, risky commands still ask):\n${where.join('\n')}]`
    : '';
  const fallback = notes.length ? 'Have a look at the attached file(s).' : 'Have a look at this.';
  blocks.push({ type: 'text', text: `${text || fallback}${note}${refNote}` });
  return blocks;
}
