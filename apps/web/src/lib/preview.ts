import type { FileProps } from '@harv/shared';
import { createStore } from './createStore.ts';

/** What the preview pane next to a chat shows (docs/PLAN.md §6s B1). */
export interface Preview {
  kind: PreviewKind;
  title: string;
  /** A file on the PC (reloaded when it changes), or… */
  path?: string;
  /** …the source itself (a fenced html, svg or mermaid block in a reply). */
  source?: string;
}

export type PreviewKind = 'html' | 'svg' | 'mermaid' | 'image' | 'pdf' | 'markdown' | 'text';

const store = createStore<Record<string, Preview>>({});
export const usePreviews = store.use;

export function openPreview(tabId: string, preview: Preview): void {
  store.set((s) => ({ ...s, [tabId]: preview }));
}

export function closePreview(tabId: string): void {
  store.set((s) => {
    const next = { ...s };
    delete next[tabId];
    return next;
  });
}

const EXT_KIND: Record<string, PreviewKind> = {
  html: 'html',
  htm: 'html',
  svg: 'svg',
  mmd: 'mermaid',
  mermaid: 'mermaid',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  pdf: 'pdf',
  md: 'markdown',
  markdown: 'markdown',
  txt: 'text',
  log: 'text',
  csv: 'text',
  json: 'text',
};

export const extOf = (path: string) => /\.([a-z0-9]{1,8})$/i.exec(path)?.[1]?.toLowerCase() ?? '';
/** How a file can be previewed, or undefined when it opens only in its own program. */
export const previewKind = (path: string): PreviewKind | undefined => EXT_KIND[extOf(path)];
/** Pictures shown right in the chat. */
export const isPicture = (path: string) => previewKind(path) === 'image' || extOf(path) === 'svg';

/** A file on the PC as the dashboard reads it (the server refuses credentials). */
export const rawUrl = (path: string) => `/api/files/raw?path=${encodeURIComponent(path)}`;

/** A local path written in a reply: a drive path on Windows, or an absolute one under the usual Linux roots. */
export const LOCAL_PATH = /^(?:[a-z]:[\\/]|\/(?:home|tmp|mnt|media|opt|srv|var|usr|run)\/)/i;

const props = new Map<string, Promise<FileProps | null>>();

/** A file's details (cached for a few seconds), or null when it isn't there. */
export function fileProps(path: string, fresh = false): Promise<FileProps | null> {
  const cached = props.get(path);
  if (cached && !fresh) return cached;
  const p = fetch(`/api/files/props?path=${encodeURIComponent(path)}`)
    .then((r) => (r.ok ? (r.json() as Promise<FileProps>) : null))
    .catch(() => null);
  props.set(path, p);
  setTimeout(() => {
    if (props.get(path) === p) props.delete(path);
  }, 5000);
  return p;
}

/** Opens a file with its own program, or shows it in its folder. */
export function openFile(path: string, reveal = false): void {
  void fetch('/api/files/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, reveal }),
  });
}

/** Text of a file on the PC (SVG and HTML come as text, never rendered by the server). */
export async function fileText(path: string): Promise<string> {
  const r = await fetch(rawUrl(path), { cache: 'no-store' });
  if (!r.ok) throw new Error(r.status === 403 ? 'Harv never opens files that may hold credentials.' : 'File not found.');
  return r.text();
}

/** An SVG as a picture: in an <img>, its scripts never run. */
export const svgUrl = (source: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;

/**
 * Files a reply names by full path, in order: in `code` (spaces allowed there) or bare
 * (no spaces). Only paths with a file extension; each once.
 */
export function pathsIn(text: string): string[] {
  const found: string[] = [];
  const add = (p: string) => {
    const clean = p.trim().replace(/[.,;:)\]]+$/, '');
    if (LOCAL_PATH.test(clean) && /\.[a-z0-9]{1,8}$/i.test(clean) && !found.includes(clean)) found.push(clean);
  };
  for (const m of text.matchAll(/`([^`\n]+)`/g)) add(m[1]!);
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    try {
      add(decodeURI(m[1]!));
    } catch {
      add(m[1]!);
    }
  }
  const bare = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]+`/g, ' ');
  for (const m of bare.matchAll(/(?<![a-z0-9])(?:[a-z]:[\\/]|(?<![\w.:/])\/(?:home|tmp|mnt|media|opt|srv)\/)[^\s"'`<>|*?]+/gi)) add(m[0]);
  return found;
}
