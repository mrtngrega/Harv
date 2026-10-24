import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EMPTY_UI, type Attachment, type ChatView, type ToolKind, type UiState } from '@harv/shared';
import { HARV_HOME } from './paths.ts';

const uiPath = () => join(HARV_HOME, 'ui.json');

/** Bigger than any real layout; a runaway dashboard can't fill the disk. */
const MAX_BYTES = 512 * 1024;
const KINDS: readonly string[] = ['terminal', 'files'] satisfies ToolKind[];
const VIEWS: readonly string[] = ['chat', 'terminal', 'files'] satisfies ChatView[];

const isId = (v: unknown): v is string => typeof v === 'string' && /^[\w-]{1,64}$/.test(v);
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Keeps the entries of a per-chat map whose key is an id and whose value passes `ok`. */
function perChat<T>(raw: unknown, ok: (v: unknown) => T | undefined): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(record(raw))) {
    const v = isId(key) ? ok(value) : undefined;
    if (v !== undefined) out[key] = v;
  }
  return out;
}

const isAttachment = (a: unknown): a is Attachment => {
  const r = record(a);
  return isId(r.id) && typeof r.name === 'string' && typeof r.size === 'number' && typeof r.mime === 'string';
};

/** Keeps only well-formed parts, so a stale or hand-edited file can't break the dashboard. */
export function cleanUi(raw: unknown): UiState {
  const r = record(raw);
  const ids = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter(isId))] : []);
  return {
    activeId: isId(r.activeId) ? r.activeId : null,
    settingsOpen: r.settingsOpen === true,
    order: ids(r.order),
    blanks: ids(r.blanks),
    tools: perChat(r.tools, (v) => (Array.isArray(v) ? (v.filter((k) => KINDS.includes(k as string)) as ToolKind[]) : undefined)),
    views: perChat(r.views, (v) => (VIEWS.includes(v as string) ? (v as ChatView) : undefined)),
    explorer: perChat(r.explorer, (v) => (typeof v === 'string' && v.length < 1024 ? v : undefined)),
    drafts: perChat(r.drafts, (v) => (typeof v === 'string' && v !== '' ? v.slice(0, 20_000) : undefined)),
    attachments: perChat(r.attachments, (v) => (Array.isArray(v) && v.length ? v.filter(isAttachment) : undefined)),
  };
}

export function loadUi(): UiState {
  try {
    return existsSync(uiPath()) ? cleanUi(JSON.parse(readFileSync(uiPath(), 'utf8'))) : EMPTY_UI;
  } catch {
    return EMPTY_UI;
  }
}

export function saveUi(raw: unknown): void {
  const json = JSON.stringify(cleanUi(raw));
  if (json.length <= MAX_BYTES) writeFileSync(uiPath(), json);
}

/** Starts the dashboard empty next time (the "reopen tabs" setting is off). */
export function resetUi(): void {
  writeFileSync(uiPath(), JSON.stringify(EMPTY_UI));
}
