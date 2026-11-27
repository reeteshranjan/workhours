// What isn't protected right now (R8.3, DESIGN §8 "Health check"). The status bar and the tab
// title read `health.warnings`.
import { store } from '../state.svelte';
import { idle } from './idle';
import { notify } from './notify';
import { healthWarnings } from './rules';
import type { Warning } from './rules';
import { sounds } from './sounds';

export type { Warning, WarningId } from './rules';

/** How long the live connection must be down before the server warning shows. */
export const SERVER_WARNING_DELAY_MS = 5000;
/** The checks that nothing signals a change for are repeated this often. */
export const RECHECK_MS = 30_000;

/** `document.wasDiscarded` isn't in TypeScript's DOM types. */
function wasDiscarded(): boolean {
  return 'wasDiscarded' in document && document.wasDiscarded === true;
}

function sameWarnings(a: Warning[], b: Warning[]): boolean {
  return a.length === b.length && a.every((w, i) => w.id === b[i]?.id && w.text === b[i]?.text);
}

/** Calls `fn` when Chrome's permission of that name changes (where the Permissions API has it). */
function watchPermission(name: string, fn: () => void): void {
  navigator.permissions
    ?.query({ name: name as PermissionName })
    .then((status) => status.addEventListener('change', fn))
    .catch(() => {});
}

class Health {
  /** The failing checks, most important first. */
  warnings = $state<Warning[]>([]);

  #serverDown = $state(false);
  /** Sticky: Chrome unloaded this page once, and that stays true until it is loaded again. */
  #discarded = false;
  #started = false;

  /** Starts watching. Runs once, in every tab. */
  start(): void {
    if (this.#started) {
      return;
    }
    this.#started = true;
    this.#discarded = wasDiscarded();

    sounds.onChange(() => void this.refresh());
    window.addEventListener('focus', () => void this.refresh());
    setInterval(() => void this.refresh(), RECHECK_MS);
    watchPermission('notifications', () => void this.refresh());
    watchPermission('idle-detection', () => void this.refresh());

    // The server warning waits for the connection to stay down. It counts from now, because the
    // connection isn't open yet when the page loads.
    $effect.root(() => {
      $effect(() => {
        if (store.connected) {
          this.#serverDown = false;
          void this.refresh();
          return;
        }
        const timer = setTimeout(() => {
          this.#serverDown = true;
          void this.refresh();
        }, SERVER_WARNING_DELAY_MS);
        return () => clearTimeout(timer);
      });
    });

    void this.refresh();
  }

  /** Checks everything again. */
  async refresh(): Promise<void> {
    const awayDetectionGranted = (await idle.permission()) === 'granted';
    const next = healthWarnings({
      serverDown: this.#serverDown,
      soundUnlocked: sounds.unlocked,
      notificationsGranted: notify.permission() === 'granted',
      awayDetectionGranted,
      discarded: this.#discarded,
      host: location.host,
    });
    if (!sameWarnings(this.warnings, next)) {
      this.warnings = next;
    }
  }
}

export const health = new Health();
