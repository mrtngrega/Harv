import type { ToolKind, ToolTab } from '@harv/shared';

const TITLES: Record<ToolKind, string> = { terminal: 'PowerShell', files: 'Files', browser: 'Browser' };

/** What a kind of tool tab needs from the server when it opens and closes. */
export interface ToolBackend {
  open(id: string): void | Promise<void>;
  close(id: string): void;
}

/**
 * The terminal, files and browser tabs open in the chat bar. They live as long
 * as the server does, so a reloaded dashboard gets them back.
 */
export class ToolRegistry {
  private tabs = new Map<string, ToolTab>();

  constructor(
    private backends: Partial<Record<ToolKind, ToolBackend>>,
    private onChange: (tabs: ToolTab[]) => void,
  ) {}

  list(): ToolTab[] {
    return [...this.tabs.values()];
  }

  has(id: string, kind?: ToolKind): boolean {
    const tab = this.tabs.get(id);
    return !!tab && (!kind || tab.kind === kind);
  }

  /** "PowerShell", then "PowerShell 2", ... */
  private titleFor(kind: ToolKind): string {
    const base = TITLES[kind];
    const taken = new Set(this.list().map((t) => t.title));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
  }

  async open(id: string, kind: ToolKind): Promise<ToolTab> {
    const existing = this.tabs.get(id);
    if (existing) return existing;
    if (!/^[\w-]{1,64}$/.test(id)) throw new Error('Bad tab id');
    const tab: ToolTab = { id, kind, title: this.titleFor(kind) };
    this.tabs.set(id, tab);
    this.onChange(this.list());
    try {
      await this.backends[kind]?.open(id);
    } catch (err) {
      this.tabs.delete(id);
      this.onChange(this.list());
      throw err;
    }
    return tab;
  }

  rename(id: string, title: string): void {
    const tab = this.tabs.get(id);
    if (!tab || tab.title === title) return;
    tab.title = title;
    this.onChange(this.list());
  }

  close(id: string): void {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.tabs.delete(id);
    this.backends[tab.kind]?.close(id);
    this.onChange(this.list());
  }
}
