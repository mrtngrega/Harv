import { useSyncExternalStore } from 'react';

/** A tiny external store: components read it with `use()` and re-render only when it changes. */
export function createStore<T>(initial: T) {
  let state = initial;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const get = () => state;
  return {
    get,
    set(next: T | ((prev: T) => T)) {
      state = typeof next === 'function' ? (next as (prev: T) => T)(state) : next;
      listeners.forEach((l) => l());
    },
    use: () => useSyncExternalStore(subscribe, get),
    /** Listens outside React (e.g. to save state); returns the unsubscribe. */
    subscribe: (listener: () => void) => {
      subscribe(listener);
      return () => void listeners.delete(listener);
    },
  };
}
