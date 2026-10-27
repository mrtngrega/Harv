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

/**
 * Draws a diagram: checked first, so a broken one shows its error here instead of Mermaid's
 * error picture, which it would otherwise leave at the end of the page (pushing the window up).
 */
async function draw(source: string): Promise<string> {
  const m = await mermaid();
  const id = `harv-mermaid-${++count}`;
  try {
    if (!(await m.parse(source, { suppressErrors: true }))) throw new Error('This isn’t a diagram Mermaid knows.');
    return (await m.render(id, source)).svg;
  } finally {
    // Whatever render left behind in the page.
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
}

/** A Mermaid diagram, drawn from its source (strict mode: no scripts or links in it). */
export function MermaidView({ source, className = '' }: { source: string; className?: string }) {
  const [state, setState] = useState<{ source: string; svg?: string; error?: string } | null>(null);
  useEffect(() => {
    let live = true;
    void draw(source).then(
      (svg) => live && setState({ source, svg }),
      (e: unknown) => live && setState({ source, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [source]);
  const current = state?.source === source ? state : null;
  if (current?.error) return <pre className="text-[11px] whitespace-pre-wrap text-warn">Couldn’t draw the diagram: {current.error}</pre>;
  if (!current?.svg) return <div className="text-[11px] text-faint">drawing…</div>;
  return <div className={`harv-mermaid overflow-auto ${className}`} dangerouslySetInnerHTML={{ __html: current.svg }} />;
}
