import { memo, useEffect, useState } from 'react';
import type { FileProps } from '@harv/shared';
import { formatSize } from '../../lib/attachments.ts';
import { getChatState } from '../../lib/chatStore.ts';
import { fileProps, fileText, isPicture, openFile, openPreview, pathsIn, previewKind, rawUrl, svgUrl, extOf } from '../../lib/preview.ts';

const lastPart = (p: string) => p.split(/[\\/]/).pop() ?? p;

const ICON: Record<string, string> = {
  doc: '▤',
  docx: '▤',
  pdf: '▤',
  xlsx: '▦',
  xls: '▦',
  csv: '▦',
  pptx: '▭',
  zip: '▣',
  html: '◇',
  htm: '◇',
  svg: '◇',
  md: '¶',
  txt: '¶',
  py: '›',
  js: '›',
  ts: '›',
};

function show(path: string) {
  const tab = getChatState().activeId;
  const kind = previewKind(path);
  if (tab && kind) openPreview(tab, { kind, title: lastPart(path), path });
}

/** A picture Harv made or named: right in the chat; a click opens it big in the preview pane. */
function PictureFile({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null>(extOf(path) === 'svg' ? null : rawUrl(path));
  useEffect(() => {
    if (extOf(path) !== 'svg') return;
    let live = true;
    // The server sends SVG as text (it can carry scripts); as an <img> it's only a picture.
    void fileText(path)
      .then((t) => live && setSrc(svgUrl(t)))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [path]);
  if (!src) return null;
  return (
    <button type="button" onClick={() => show(path)} title={path} className="block cursor-zoom-in">
      <img src={src} alt={lastPart(path)} loading="lazy" className="max-h-72 max-w-full rounded-lg border border-line" />
    </button>
  );
}

/** A file Harv made or named, as a card: Open, Show in folder, and Preview when the pane can show it. */
function FileCard({ path, props }: { path: string; props: FileProps }) {
  const ext = extOf(path);
  const canPreview = !!previewKind(path);
  const btn = 'cursor-pointer rounded px-1.5 py-0.5 text-[11px] hover:bg-white/10';
  return (
    <div className="flex max-w-full min-w-0 items-center gap-2 rounded-lg border border-line bg-white/[0.04] px-2.5 py-1.5" title={path}>
      <span aria-hidden="true" className="text-accent">
        {ICON[ext] ?? '▤'}
      </span>
      <span className="min-w-0 truncate text-xs text-ink">{props.name}</span>
      <span className="flex-none text-[11px] text-faint">{props.dir ? 'folder' : formatSize(props.size)}</span>
      <span className="ml-auto flex flex-none gap-0.5">
        {canPreview && (
          <button type="button" onClick={() => show(path)} className={`${btn} text-accent`}>
            preview
          </button>
        )}
        <button type="button" onClick={() => openFile(path)} className={`${btn} text-muted hover:text-accent`}>
          open
        </button>
        <button type="button" onClick={() => openFile(path, true)} className={`${btn} text-muted hover:text-accent`}>
          show in folder
        </button>
      </span>
    </div>
  );
}

/** The files a reply names by full path that exist: pictures inline, everything else as cards (docs/PLAN.md §6s B2, B3). */
export const FileCards = memo(function FileCards({ text }: { text: string }) {
  const [found, setFound] = useState<{ path: string; props: FileProps }[]>([]);
  useEffect(() => {
    let live = true;
    const paths = pathsIn(text).slice(0, 12);
    if (!paths.length) return;
    void Promise.all(paths.map(async (path) => ({ path, props: await fileProps(path) }))).then((all) => {
      if (live) setFound(all.filter((f): f is { path: string; props: FileProps } => !!f.props && !f.props.dir));
    });
    return () => {
      live = false;
    };
  }, [text]);
  if (!found.length) return null;
  const pictures = found.filter((f) => isPicture(f.path));
  const files = found.filter((f) => !isPicture(f.path));
  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {pictures.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {pictures.map((f) => (
            <PictureFile key={f.path} path={f.path} />
          ))}
        </div>
      )}
      {files.map((f) => (
        <FileCard key={f.path} path={f.path} props={f.props} />
      ))}
    </div>
  );
});
