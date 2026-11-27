// Away detection with Chrome's IdleDetector, reported to the server (DESIGN §6.4).
// Only the leader tab starts it (leader.ts).
import * as api from '../api';
import type { IdleSnapshot } from './rules';

/** The user counts as away after this long without input (must match the server's, §6.4). */
export const IDLE_THRESHOLD_MS = 600_000;

type Permission = PermissionState | 'unsupported';

let latest: IdleSnapshot | null = null;
let running = false;
let starting: Promise<boolean> | null = null;
let permissionWatch: PermissionStatus | null = null;

function supported(): boolean {
  return typeof IdleDetector !== 'undefined';
}

async function queryPermission(): Promise<PermissionStatus | null> {
  try {
    return await navigator.permissions.query({ name: 'idle-detection' as PermissionName });
  } catch {
    return null;
  }
}

/** Takes in a detector's state and tells the server if it differs from the last one reported. */
function report(detector: IdleDetector): void {
  const user = detector.userState;
  const screen = detector.screenState;
  if (user === null || screen === null) {
    return;
  }
  if (latest && latest.user === user && latest.screen === screen) {
    return;
  }
  latest = { user, screen };
  // A failure (server down) is not retried: the next change reports again.
  api.reportPresence({ user, screen, at: Date.now() }).catch(() => {});
}

async function begin(): Promise<boolean> {
  if ((await idle.permission()) !== 'granted') {
    await watchForPermission();
    return false;
  }
  try {
    const detector = new IdleDetector();
    detector.addEventListener('change', () => report(detector));
    await detector.start({ threshold: IDLE_THRESHOLD_MS });
    running = true;
    // The initial state counts as a change: the server may need it (a screen locked at load).
    report(detector);
    return true;
  } catch {
    return false;
  }
}

/** If the user grants the permission later, from any tab, start then. */
async function watchForPermission(): Promise<void> {
  if (permissionWatch) {
    return;
  }
  const status = await queryPermission();
  if (!status) {
    return;
  }
  permissionWatch = status;
  status.addEventListener('change', () => {
    if (status.state === 'granted') {
      void idle.start();
    }
  });
}

export const idle = {
  /** 'granted', 'denied', 'prompt', or 'unsupported'. */
  async permission(): Promise<Permission> {
    if (!supported()) {
      return 'unsupported';
    }
    const status = await queryPermission();
    return status ? status.state : 'unsupported';
  },

  /** Asks Chrome for the permission. Call it from a click. */
  async requestPermission(): Promise<Permission> {
    if (!supported()) {
      return 'unsupported';
    }
    try {
      return await IdleDetector.requestPermission();
    } catch {
      // No user gesture, or the prompt was dismissed: the permission is whatever it was.
      return idle.permission();
    }
  },

  /**
   * Starts the detector if permission is granted, and reports its state and every change to the
   * server. Does nothing if it is already running. Returns false if it couldn't start.
   */
  start(): Promise<boolean> {
    if (running) {
      return Promise.resolve(true);
    }
    starting ??= begin().finally(() => {
      starting = null;
    });
    return starting;
  },

  /**
   * Sends the latest state again. Call it when the live connection comes back: a restarted server
   * knows nothing about presence until told, and needs it to notice the user is back (§6.3, §6.4).
   */
  resend(): void {
    if (running && latest) {
      api.reportPresence({ ...latest, at: Date.now() }).catch(() => {});
    }
  },

  /** The latest state, or null if the detector isn't running. */
  get current(): IdleSnapshot | null {
    return running && latest ? { ...latest } : null;
  },
};
