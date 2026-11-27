// The Idle Detection API (Chrome). TypeScript's DOM types don't include it yet.
// https://developer.mozilla.org/docs/Web/API/IdleDetector

interface IdleDetectorStartOptions {
  /** Milliseconds without input before `userState` becomes 'idle'. At least 60 000. */
  threshold?: number;
  signal?: AbortSignal;
}

declare class IdleDetector extends EventTarget {
  constructor();
  /** Null until `start()` has resolved. */
  readonly userState: 'active' | 'idle' | null;
  readonly screenState: 'locked' | 'unlocked' | null;
  /** Fires with type 'change' when `userState` or `screenState` changes. */
  onchange: ((this: IdleDetector, event: Event) => unknown) | null;
  /** Needs the 'idle-detection' permission, or rejects. */
  start(options?: IdleDetectorStartOptions): Promise<void>;
  /** Needs a user gesture. */
  static requestPermission(): Promise<'granted' | 'denied'>;
}
