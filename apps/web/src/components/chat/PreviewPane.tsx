import { useEffect, useState } from 'react';
import { closePreview, fileProps, fileText, openFile, rawUrl, svgUrl, type Preview } from '../../lib/preview.ts';
import { MermaidView } from './Mermaid.tsx';
import { RichText } from './RichText.tsx';

/** A file preview follows the file: when Harv changes it, the pane reloads (checked every 2 s while it's open). */
function useModified(path: string | undefined): number {
  const [modified, setModified] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    const check = () =>
      void fileProps(path, true).then((p) => {
        if (live && p) setModified(p.modified);
      });
    check();
    const timer = setInterval(check, 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [path]);
  return modified;
}

/** The text a preview shows: its source, or the file's text (reloaded when the file changes). */
function useSource(preview: Preview, modified: number): { text: string | null; error: string | null } {
  const [loaded, setLoaded] = useState<{ path: string; text: string | null; error: string | null } | null>(null);
  const needsText = !!preview.path && ['html', 'svg', 'mermaid', 'markdown', 'text'].includes(preview.kind);
  useEffect(() => {
    if (!needsText || !preview.path) return;
    const path = preview.path;
    let live = true;
    void fileText(path)
      .then((text) => live && setLoaded({ path, text, error: null }))
      .catch((e: Error) => live && setLoaded({ path, text: null, error: e.message }));
    return () => {
      live = false;
    };
  }, [preview.path, needsText, modified]);
  if (!needsText) return { text: preview.source ?? null, error: null };
  return loaded && loaded.path === preview.path ? loaded : { text: null, error: null };
}

function Body({ preview, modified, reload }: { preview: Preview; modified: number; reload: number }) {
  const { text, error } = useSource(preview, modified + reload);
  if (error) return <p className="p-4 text-warn">{error}</p>;
  const bust = `&v=${modified}-${reload}`;
  switch (preview.kind) {
    case 'image':
      return (
        <div className="flex h-full items-center justify-center overflow-auto p-3">
          <img src={`${rawUrl(preview.path!)}${bust}`} alt={preview.title} className="max-h-full max-w-full object-contain" />
        </div>
      );
    case 'pdf':
      return <iframe title={preview.title} src={`${rawUrl(preview.path!)}${bust}`} className="size-full border-0 bg-white" />;
    case 'html':
      // Its own opaque origin (no allow-same-origin): the page's scripts run, but can't reach Harv's API or the dashboard.
      return text === null ? null : (
        <iframe
          key={`${modified}-${reload}`}
          title={preview.title}
          srcDoc={text}
          sandbox="allow-scripts allow-forms allow-popups allow-modals"
          className="size-full border-0 bg-white"
        />
      );
    case 'svg':
      return text === null ? null : (
        <div className="flex h-full items-center justify-center overflow-auto p-3">
          <img src={svgUrl(text)} alt={preview.title} className="max-h-full max-w-full" />
        </div>
      );
    case 'mermaid':
      return text === null ? null : <MermaidView source={text} className="h-full p-4" />;
    case 'markdown':
      return text === null ? null : (
        <div className="harv-md h-full overflow-auto p-4">
          <RichText text={text} />
        </div>
      );
    case 'text':
      return <pre className="m-0 h-full overflow-auto p-4 text-xs whitespace-pre-wrap text-ink">{text}</pre>;
  }
}

/** The live preview next to a chat (docs/PLAN.md §6s B1): HTML pages, SVG, Mermaid, pictures, PDFs, Markdown. */
export function PreviewPane({ tabId, preview }: { tabId: string; preview: Preview }) {
  const modified = useModified(preview.path);
  const [reload, setReload] = useState(0);
  const btn = 'cursor-pointer rounded px-2 py-1 text-[11px] text-muted hover:bg-white/10 hover:text-accent';
  return (
    <aside aria-label="Preview" className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-black/25">
      <div className="flex flex-none items-center gap-1 border-b border-line px-2 py-1">
        <span className="mr-auto min-w-0 truncate text-xs text-ink" title={preview.path ?? preview.title}>
          <span className="text-accent">◇</span> {preview.title}
        </span>
        <button type="button" onClick={() => setReload((r) => r + 1)} className={btn} title="Reload">
          ↻
        </button>
        {preview.path && (
          <button type="button" onClick={() => openFile(preview.path!)} className={btn} title="Open with its own program">
            open
          </button>
        )}
        <button type="button" onClick={() => closePreview(tabId)} aria-label="Close the preview" className={btn}>
          ×
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <Body preview={preview} modified={modified} reload={reload} />
      </div>
    </aside>
  );
}
