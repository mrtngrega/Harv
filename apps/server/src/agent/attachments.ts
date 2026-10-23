import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Attachment } from '@harv/shared';
import { HARV_HOME } from '../paths.ts';

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

/** The user's message as content blocks: inline files first, then the text with a note of where each file is saved. */
export function buildContent(tabId: string, text: string, files: Attachment[]): ContentBlockParam[] {
  const blocks: ContentBlockParam[] = [];
  const notes: string[] = [];
  for (const file of files) {
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
  blocks.push({ type: 'text', text: `${text || 'Have a look at the attached file(s).'}${note}` });
  return blocks;
}
