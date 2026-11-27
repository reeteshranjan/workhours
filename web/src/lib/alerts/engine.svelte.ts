// The alert rules in action (R7, DESIGN §7.2). Only the leader tab (leader.ts) plays sounds,
// shows notifications and runs away detection. What to alert is decided in rules.ts.
import { untrack } from 'svelte';
import { getState } from '../api';
import type { AppState } from '../../../../shared/types.js';
import { store } from '../state.svelte';
import { health } from './health.svelte';
import { idle } from './idle';
import { becomeLeaderWhenPossible } from './leader';
import { notify } from './notify';
import {
  SERVER_DOWN_NOTIFICATION,
  SOUND_BLOCKED_NOTIFICATION,
  awayNotification,
  chooseReturnAlert,
  lastProjectOf,
  nothingNotification,
  shouldChime,
  shouldRepeatNothing,
} from './rules';
import { sounds } from './sounds';

/** "Nothing is running" repeats once, this long after the first alert (R7.3). */
export const NOTHING_REPEAT_MS = 10 * 60_000;
/** The connection must be down this long, and /api/health failing, before the alert (R7.4). */
export const SERVER_ALERT_DELAY_MS = 30_000;
/** The server alert repeats this often while a project was running when it stopped (R7.4). */
export const SERVER_REPEAT_MS = 5 * 60_000;
/** Sound still blocked this long after the page loaded gets a notification (R8.2). */
export const SOUND_REMINDER_MS = 60_000;
/** How long /api/health gets to answer before the server counts as unreachable. */
const HEALTH_TIMEOUT_MS = 5000;

type Timer = ReturnType<typeof setTimeout>;

let started = false;

let nothingTimer: Timer | undefined;
let serverTimer: Timer | undefined;
/** Whether a project was running when the connection was lost. */
let runningWhenLost = false;

/**
 * Starts the alerts. Call once, when the app mounts, after `store.start()`. Every tab registers
 * the service worker and keeps the health check; the leader tab does the rest.
 */
export function startAlerts(): void {
  if (started) {
    return;
  }
  started = true;
  void notify.register();
  health.start();
  becomeLeaderWhenPossible(runAsLeader);
}

function runAsLeader(): void {
  void idle.start();
  store.on('returned', () => void onReturned());
  store.on('checkin', onCheckin);
  watchSoundBlocked();

  $effect.root(() => {
    // Null until the first state arrives. As derived values they change only when the answer does,
    // not every time the state is replaced.
    const hasAwayNotices = $derived(store.state ? store.state.awayNotices.length > 0 : null);
    const isRunning = $derived(store.state ? store.state.running !== null : null);

    $effect(() => {
      const volume = store.state?.settings.volume;
      if (volume !== undefined) {
        sounds.setVolume(volume);
      }
    });

    $effect(() => {
      if (hasAwayNotices === false) {
        void notify.close('away');
      }
    });

    $effect(() => {
      if (isRunning === true) {
        clearNothingTimer();
        void notify.close('nothing');
      }
    });

    $effect(() => {
      const connected = store.connected;
      untrack(() => onConnection(connected));
    });
  });
}

// ---- Back from away, nothing running (R7.2, R7.3) ----

async function onReturned(): Promise<void> {
  clearNothingTimer();
  // Decide from the state, not from the event: its session ids can be empty. The state is fetched
  // here and used as fetched. `store.refresh()` would not do: when the `state` event that follows
  // `returned` starts another refresh, the first one is dropped and `store.state` is still the
  // one from before the return.
  let state: AppState;
  try {
    state = await getState();
  } catch {
    return;
  }
  const alert = chooseReturnAlert(state);
  if (!alert) {
    return;
  }
  sounds.alertTone();
  if (alert.kind === 'away') {
    void notify.show('away', awayNotification(alert.notice, Date.now()));
    return;
  }
  void notify.show('nothing', nothingNotification(alert.lastProject));
  nothingTimer = setTimeout(repeatNothing, NOTHING_REPEAT_MS);
}

/** The one repeat. */
function repeatNothing(): void {
  nothingTimer = undefined;
  const state = store.state;
  if (!state || !shouldRepeatNothing(state, idle.current)) {
    return;
  }
  sounds.alertTone();
  // The project to resume may have changed since the first alert.
  void notify.show('nothing', nothingNotification(lastProjectOf(state)));
}

function clearNothingTimer(): void {
  clearTimeout(nothingTimer);
  nothingTimer = undefined;
}

// ---- Check-in (R7.6) ----

function onCheckin(): void {
  if (shouldChime(idle.current)) {
    sounds.chime();
  }
}

// ---- Server unreachable (R7.4) ----

function onConnection(connected: boolean): void {
  clearTimeout(serverTimer);
  serverTimer = undefined;
  if (connected) {
    void notify.close('server');
    // A restarted server has no presence report, so it can't tell the user is back.
    idle.resend();
    return;
  }
  runningWhenLost = store.state?.running != null;
  serverTimer = setTimeout(() => void checkServer(), SERVER_ALERT_DELAY_MS);
}

async function serverReachable(): Promise<boolean> {
  try {
    const response = await fetch('/api/health', { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return response.ok;
  } catch {
    return false;
  }
}

async function checkServer(): Promise<void> {
  serverTimer = undefined;
  if (store.connected) {
    return;
  }
  const reachable = await serverReachable();
  // The connection may have come back while /api/health was being tried.
  if (reachable || store.connected) {
    return;
  }
  sounds.alertTone();
  void notify.show('server', SERVER_DOWN_NOTIFICATION);
  if (runningWhenLost) {
    serverTimer = setTimeout(() => void checkServer(), SERVER_REPEAT_MS);
  }
}

// ---- Sound blocked after a reload (R8.2) ----

function watchSoundBlocked(): void {
  if (sounds.unlocked) {
    return;
  }
  const timer = setTimeout(() => {
    if (!sounds.unlocked) {
      void notify.show('sound', SOUND_BLOCKED_NOTIFICATION);
    }
  }, SOUND_REMINDER_MS);
  const stop = sounds.onChange(() => {
    if (sounds.unlocked) {
      clearTimeout(timer);
      void notify.close('sound');
      stop();
    }
  });
}
