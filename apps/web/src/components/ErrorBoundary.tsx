import { Component, type ReactNode } from 'react';

/**
 * Keeps one broken part from blanking the whole window: a view that fails to load (Vite
 * unreachable for a moment) or throws shows a line with Retry instead. `whole` is the outermost
 * one: there Retry reloads the page.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; label?: string; whole?: boolean }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    // React keeps a failed lazy import, so only a reload brings that view back.
    const failedLoad = /dynamically imported module|importing a module script failed|error loading/i.test(error.message);
    const retry = () => (this.props.whole || failedLoad ? location.reload() : this.setState({ error: null }));
    return (
      <div role="alert" className="m-auto flex max-w-md flex-col items-center gap-2 p-6 text-center text-xs text-muted">
        <p>
          {this.props.whole ? 'Something in Harv’s window broke.' : `Couldn’t show the ${this.props.label ?? 'view'}.`}{' '}
          <span className="text-faint">{error.message}</span>
        </p>
        <button
          type="button"
          onClick={retry}
          className="cursor-pointer rounded-lg border border-accent/50 px-3 py-1 text-accent hover:bg-accent/15"
        >
          {this.props.whole ? 'Reload' : 'Retry'}
        </button>
      </div>
    );
  }
}

/** A lazy view's import, tried a few times (Vite may be unreachable for a moment) before it counts as failed. */
export function retryImport<T>(load: () => Promise<T>, tries = 3): Promise<T> {
  return load().catch((err: unknown) =>
    tries > 1
      ? new Promise<T>((resolve, reject) => setTimeout(() => retryImport(load, tries - 1).then(resolve, reject), 1000))
      : Promise.reject(err),
  );
}
