// The UI's reactive store: the latest server state, a server-aligned clock, and the live
// event stream. Nothing starts at import time; App calls `store.start()` once.
import type { AppState, EventName, EventPayloads, ProjectSummary } from '../../../shared/types.js';
import { ApiFailure, getState } from './api';

const TICK_MS = 1000;
const GENERIC_MESSAGE = 'Something went wrong.';

/** Every event except `state`, which just triggers a refresh. Keyed so a new event can't be missed. */
const PAYLOAD_EVENTS: Record<Exclude<EventName, 'state'>, true> = {
  autopause: true,
  returned: true,
  checkin: true,
};

type Handler = (data: unknown) => void;

function isAppState(value: unknown): value is AppState {
  return (
    typeof value === 'object' &&
    value !== null &&
    'projects' in value &&
    Array.isArray(value.projects) &&
    'now' in value &&
    typeof value.now === 'number'
  );
}

class Store {
  state = $state<AppState | null>(null);
  /** Server-aligned current time, updated every second (R2.4). */
  now = $state(Date.now());
  /** True while the live event stream is open. */
  connected = $state(false);
  /** The latest action error to show the user, or null. */
  error = $state<string | null>(null);

  /** Server time minus this machine's time, from the latest state. */
  #offset = 0;
  /** Bumped by every refresh and apply, so a slow response can tell it was overtaken. */
  #sequence = 0;
  #started = false;
  #handlers = new Map<EventName, Set<Handler>>();

  /** Loads the state, opens the live event stream and starts the one-second clock. Runs once. */
  start(): void {
    if (this.#started) {
      return;
    }
    this.#started = true;
    void this.refresh();
    this.#openEvents();
    setInterval(() => {
      this.now = Date.now() + this.#offset;
    }, TICK_MS);
  }

  /** Fetches /api/state and applies it, unless something newer arrived in the meantime. */
  async refresh(): Promise<void> {
    const sequence = ++this.#sequence;
    let fetched: AppState;
    try {
      fetched = await getState();
    } catch {
      // A failure shows as `connected` going false (or `state` staying null), not as an error.
      return;
    }
    if (sequence === this.#sequence) {
      this.#set(fetched);
    }
  }

  /** Uses a state the server just returned. */
  apply(s: AppState): void {
    this.#sequence++;
    this.#set(s);
  }

  /**
   * Runs an API call. On success it applies the AppState the call returned (if it returned one)
   * and clears `error`. On failure it sets `error` and returns undefined.
   */
  async run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    let result: T;
    try {
      result = await fn();
    } catch (err) {
      this.error = err instanceof ApiFailure ? err.message : GENERIC_MESSAGE;
      return undefined;
    }
    this.error = null;
    if (isAppState(result)) {
      this.apply(result);
    }
    return result;
  }

  /** Subscribes to a live event (used for alerts). Returns the unsubscribe function. */
  on<K extends EventName>(name: K, handler: (data: EventPayloads[K]) => void): () => void {
    const entry = handler as Handler;
    let set = this.#handlers.get(name);
    if (!set) {
      // Not reactive state: nothing renders from the list of listeners.
      // eslint-disable-next-line svelte/prefer-svelte-reactivity
      set = new Set();
      this.#handlers.set(name, set);
    }
    set.add(entry);
    return () => {
      set.delete(entry);
    };
  }

  /** The project's current time, including the time since the state arrived if it is running. */
  liveCurrentMs(project: ProjectSummary): number {
    return project.currentMs + this.#runningMs(project);
  }

  liveTotalMs(project: ProjectSummary): number {
    return project.totalMs + this.#runningMs(project);
  }

  get runningProject(): ProjectSummary | null {
    const running = this.state?.running;
    if (!running) {
      return null;
    }
    return this.state?.projects.find((p) => p.id === running.projectId) ?? null;
  }

  /** The project that ran last while nothing is running, or null if it has since been closed. */
  get lastProject(): ProjectSummary | null {
    const lastProjectId = this.state?.paused?.lastProjectId;
    if (lastProjectId === undefined || lastProjectId === null) {
      return null;
    }
    return this.state?.projects.find((p) => p.id === lastProjectId) ?? null;
  }

  #set(s: AppState): void {
    this.#offset = s.now - Date.now();
    this.state = s;
    this.now = Date.now() + this.#offset;
  }

  /** Time the project has run since the state arrived: zero unless it is the running one. */
  #runningMs(project: ProjectSummary): number {
    const s = this.state;
    if (!s || s.running?.projectId !== project.id) {
      return 0;
    }
    return Math.max(0, this.now - s.now);
  }

  #openEvents(): void {
    if (typeof EventSource === 'undefined') {
      return;
    }
    const source = new EventSource('/api/events');
    source.addEventListener('open', () => {
      this.connected = true;
      // The state may have changed while the stream was down.
      void this.refresh();
    });
    // EventSource reconnects by itself, so the stream is never closed here.
    source.addEventListener('error', () => {
      this.connected = false;
    });
    source.addEventListener('state', () => {
      void this.refresh();
      this.#dispatch('state', {});
    });
    for (const name of Object.keys(PAYLOAD_EVENTS) as (keyof typeof PAYLOAD_EVENTS)[]) {
      source.addEventListener(name, (event) => {
        let data: unknown;
        try {
          data = JSON.parse((event as MessageEvent<string>).data);
        } catch {
          return;
        }
        this.#dispatch(name, data);
      });
    }
  }

  #dispatch(name: EventName, data: unknown): void {
    for (const handler of [...(this.#handlers.get(name) ?? [])]) {
      try {
        handler(data);
      } catch (err) {
        // One failing listener must not stop the others.
        console.error(`Handler for "${name}" failed`, err);
      }
    }
  }
}

export const store = new Store();
