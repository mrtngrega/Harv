import { createContext, memo, useContext, useEffect, useState, type ReactNode } from 'react';
import Markdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getChatState } from '../../lib/chatStore.ts';
import { LOCAL_PATH, openPreview, rawUrl, type PreviewKind } from '../../lib/preview.ts';
import { MermaidView } from './Mermaid.tsx';

/** The reply is still streaming in. */
const Streaming = createContext(false);

type Hast = { type: string; value?: string; children?: Hast[]; properties?: Record<string, unknown> };

/** The plain text of a highlighted code block (its spans joined back up). */
const textOf = (node: Hast | undefined): string =>
  !node ? '' : node.type === 'text' ? (node.value ?? '') : (node.children ?? []).map(textOf).join('');

/** Fenced blocks that open in the preview pane. */
const PREVIEWABLE: Record<string, PreviewKind> = { html: 'html', svg: 'svg', xml: 'svg', mermaid: 'mermaid' };

function preview(kind: PreviewKind, source: string, title: string) {
  const tab = getChatState().activeId;
  if (tab) openPreview(tab, { kind, title, source });
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
      className="cursor-pointer rounded px-1.5 text-[11px] text-muted hover:bg-white/10 hover:text-accent"
    >
      {done ? 'copied' : 'copy'}
    </button>
  );
}

/** A code block: its language, Copy, and Preview for HTML, SVG and Mermaid; Mermaid draws right away. */
function CodeBlock({ node, children }: { node?: Hast; children?: ReactNode }) {
  const code = node?.children?.find((c) => c.type === 'element');
  const classes = (code?.properties?.className as string[] | undefined) ?? [];
  const lang =
    classes
      .find((c) => c.startsWith('language-'))
      ?.slice(9)
      .toLowerCase() ?? '';
  const text = textOf(code).replace(/\n$/, '');
  const kind = PREVIEWABLE[lang === 'xml' && !/<svg[\s>]/i.test(text) ? '' : lang];
  const [showCode, setShowCode] = useState(false);
  // A diagram still being written isn't drawn yet (half a diagram is a syntax error).
  const streaming = useContext(Streaming);
  const diagram = lang === 'mermaid' && !streaming;
  return (
    <div className="harv-code my-2 overflow-hidden rounded-[10px] border border-line bg-black/30">
      <div className="flex items-center gap-1 border-b border-line px-2 py-0.5 text-[11px] text-faint">
        <span className="mr-auto">{lang || 'text'}</span>
        {diagram && (
          <button
            type="button"
            onClick={() => setShowCode(!showCode)}
            className="cursor-pointer rounded px-1.5 hover:bg-white/10 hover:text-accent"
          >
            {showCode ? 'diagram' : 'source'}
          </button>
        )}
        {kind && (
          <button
            type="button"
            onClick={() => preview(kind, text, diagram ? 'Diagram' : lang === 'html' ? 'HTML page' : 'SVG')}
            className="cursor-pointer rounded px-1.5 text-accent hover:bg-white/10"
          >
            preview ↗
          </button>
        )}
        <CopyButton text={text} />
      </div>
      {diagram && !showCode ? (
        <div className="p-3">
          <MermaidView source={text} />
        </div>
      ) : (
        <pre className="!m-0 !rounded-none !border-0 !bg-transparent">{children}</pre>
      )}
    </div>
  );
}

/** A picture in a reply: a file on the PC goes through the dashboard's file API; SVG as an <img>, so no scripts. */
function Picture({ src, alt }: { src?: string; alt?: string }) {
  if (!src) return null;
  const local = src.startsWith('/api/files/raw');
  return (
    <img
      src={src}
      alt={alt ?? ''}
      loading="lazy"
      onClick={() => {
        const tab = getChatState().activeId;
        const path = local ? new URL(src, location.origin).searchParams.get('path') : null;
        if (tab && path) openPreview(tab, { kind: 'image', title: alt || path, path });
      }}
      className={`my-1 max-h-80 max-w-full rounded-lg border border-line ${local ? 'cursor-zoom-in' : ''}`}
    />
  );
}

const COMPONENTS: Components = {
  pre: CodeBlock as Components['pre'],
  img: Picture as Components['img'],
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
};

/** Local paths in links and pictures go through the file API; everything else as react-markdown allows. */
function urlTransform(url: string): string {
  if (LOCAL_PATH.test(url)) return rawUrl(url);
  return defaultUrlTransform(url);
}

type Plugins = { remark: unknown[]; rehype: unknown[] };
const BASIC: Plugins = { remark: [remarkGfm], rehype: [] };
let extras: Plugins | null = null;
let loadingExtras: Promise<Plugins> | null = null;
/** Highlighting and math load the first time a reply needs them: they'd double the dashboard's first load. */
function loadExtras(): Promise<Plugins> {
  loadingExtras ??= import('./markdownExtras.ts').then(
    (m) => (extras = { remark: [remarkGfm, ...m.remarkExtras], rehype: m.rehypeExtras }),
  );
  return loadingExtras;
}
const needsExtras = (text: string) => text.includes('```') || text.includes('$$') || /^ {4}\S/m.test(text);

function usePlugins(text: string): Plugins {
  const wanted = needsExtras(text);
  const [plugins, setPlugins] = useState<Plugins>(wanted && extras ? extras : BASIC);
  useEffect(() => {
    if (!wanted || plugins !== BASIC) return;
    let live = true;
    void loadExtras().then((p) => live && setPlugins(p));
    return () => {
      live = false;
    };
  }, [wanted, plugins]);
  return plugins;
}

/**
 * Harv's Markdown (docs/PLAN.md §6s B4): tables, math ($$…$$, inline or on its own lines),
 * highlighted code with Copy, Mermaid diagrams, pictures from the PC, and HTML/SVG previews.
 * Single $ stays a dollar sign: prices are more common in chat than inline math.
 */
export const RichText = memo(function RichText({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const plugins = usePlugins(text);
  return (
    <Streaming.Provider value={streaming}>
      <Markdown
        remarkPlugins={plugins.remark as never}
        rehypePlugins={plugins.rehype as never}
        components={COMPONENTS}
        urlTransform={urlTransform}
      >
        {text}
      </Markdown>
    </Streaming.Provider>
  );
});
