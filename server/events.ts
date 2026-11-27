import type { EventName, EventPayloads } from '../shared/types.js';

/** One open tab: whatever can push a named event to it (an SSE stream, in the app). */
export interface EventClient {
  send(name: EventName, data: unknown): void;
}

/** The set of connected tabs (DESIGN §6.1, §9.1). */
export class EventHub {
  /** Called after the number of connected clients changes. */
  onCountChange: ((count: number) => void) | null = null;

  // Wrapped, so the same client added twice is two connections with their own remove().
  private readonly entries = new Set<{ client: EventClient }>();

  get count(): number {
    return this.entries.size;
  }

  /** Returns a function that removes the client again. Calling it more than once does nothing. */
  add(client: EventClient): () => void {
    const entry = { client };
    this.entries.add(entry);
    this.onCountChange?.(this.entries.size);
    return () => {
      if (this.entries.delete(entry)) {
        this.onCountChange?.(this.entries.size);
      }
    };
  }

  /** Sends to every client. A client whose send throws is dropped; the others still get it. */
  broadcast<K extends EventName>(name: K, data: EventPayloads[K]): void {
    // A copy, because a send can end up removing a client.
    for (const entry of [...this.entries]) {
      try {
        entry.client.send(name, data);
      } catch {
        if (this.entries.delete(entry)) {
          this.onCountChange?.(this.entries.size);
        }
      }
    }
  }
}
