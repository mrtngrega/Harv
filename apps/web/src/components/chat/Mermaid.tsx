import { useEffect, useState } from 'react';

let loading: Promise<typeof import('mermaid').default> | null = null;
let count = 0;

/** Mermaid is big: it loads the first time a diagram shows up. */
function mermaid() {
  loading ??= import('mermaid').then((m) => {
    m.default.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'dark',
      fontFamily: '"IBM Plex Mono", monospace',
      themeVariables: { background: 'transparent', primaryColor: '#1c2733', primaryTextColor: '#dce8f5', lineColor: '#a8c8e8' },
    });
    return m.default;
  });
  return loading;
}

/** A Mermaid diagram, drawn from its source (strict mode: no scripts or links in it). */
export function MermaidView({ source, className = '' }: { source: string; className?: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void mermaid()
      .then((m) => m.render(`harv-mermaid-${++count}`, source))
      .then((r) => live && (setSvg(r.svg), setError(null)))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [source]);
  if (error) return <pre className="text-[11px] whitespace-pre-wrap text-warn">Couldn’t draw the diagram: {error}</pre>;
  if (!svg) return <div className="text-[11px] text-faint">drawing…</div>;
  return <div className={`harv-mermaid overflow-auto ${className}`} dangerouslySetInnerHTML={{ __html: svg }} />;
}
