type Handler<T> = (payload: T) => void;

/** Minimal typed event emitter. `on` returns an unsubscribe function. */
export class Emitter<Events extends Record<string, unknown>> {
  private handlers: { [K in keyof Events]?: Set<Handler<Events[K]>> } = {};

  on<K extends keyof Events>(event: K, fn: Handler<Events[K]>): () => void {
    (this.handlers[event] ??= new Set()).add(fn);
    return () => this.handlers[event]?.delete(fn);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    // Iterate a snapshot: a handler subscribed during this emit (e.g. a screen opened
    // by a pinch) must not receive the very event that opened it.
    const set = this.handlers[event];
    if (set) for (const fn of [...set]) fn(payload);
  }
}
