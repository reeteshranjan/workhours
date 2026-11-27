// The alert rules as pure functions (R7, DESIGN §7.2): what to alert, and what the alert says.
// No browser APIs here, so they can be unit-tested. engine.svelte.ts does the doing.
import type { AppState, AwayNotice, ProjectSummary } from '../../../../shared/types.js';
import { dayAndTime, duration, reasonLabel } from '../format.js';

/** What the leader tab's IdleDetector last reported. */
export interface IdleSnapshot {
  user: 'active' | 'idle';
  screen: 'locked' | 'unlocked';
}

export interface NotificationAction {
  action: string;
  title: string;
}

/** What to show; `kind` and the delivery are up to notify.ts. */
export interface AlertNotification {
  title: string;
  body: string;
  actions: NotificationAction[];
  data?: unknown;
}

export type ReturnAlert =
  { kind: 'away'; notice: AwayNotice } | { kind: 'nothing'; lastProject: ProjectSummary | null };

// ---- The user is back ----

/** The most recent automatic pause the user has already come back from (highest session id). */
export function latestReturnedNotice(state: AppState): AwayNotice | null {
  let latest: AwayNotice | null = null;
  for (const notice of state.awayNotices) {
    if (notice.returnedAt !== null && (latest === null || notice.sessionId > latest.sessionId)) {
      latest = notice;
    }
  }
  return latest;
}

/** The project that ran last while nothing is running, or null if it has since been closed. */
export function lastProjectOf(state: AppState): ProjectSummary | null {
  const id = state.paused?.lastProjectId;
  if (id === undefined || id === null) {
    return null;
  }
  return state.projects.find((p) => p.id === id) ?? null;
}

/**
 * What to raise when the user returns (DESIGN §7.2), decided from the state and not from the
 * `returned` event's session ids, which can be empty for a pause that was already marked returned.
 * A returned automatic pause wins over "nothing is running", because its alert already offers
 * Resume. Null means no alert.
 */
export function chooseReturnAlert(state: AppState): ReturnAlert | null {
  const notice = latestReturnedNotice(state);
  if (notice) {
    return { kind: 'away', notice };
  }
  if (state.running === null) {
    return { kind: 'nothing', lastProject: lastProjectOf(state) };
  }
  return null;
}

/**
 * "Acme Website auto-paused 14:02" ("auto-paused yesterday 17:45" for an earlier day),
 * "screen locked · away 45m", with Count and Resume buttons.
 * `now` stands in for the return time of a pause the user hasn't come back from yet.
 */
export function awayNotification(notice: AwayNotice, now: number): AlertNotification {
  const away = duration((notice.returnedAt ?? now) - notice.pausedAt);
  return {
    title: `${notice.projectName} auto-paused ${dayAndTime(notice.pausedAt, now)}`,
    body: `${reasonLabel(notice.reason)} · away ${away}`,
    actions: [
      { action: 'count', title: `Count the ${away}` },
      { action: 'resume', title: 'Resume' },
    ],
    data: { sessionId: notice.sessionId },
  };
}

/** "Nothing is running", with a Resume button when the last project is still open. */
export function nothingNotification(lastProject: ProjectSummary | null): AlertNotification {
  return {
    title: 'Nothing is running',
    body: 'Start a project to count your time.',
    actions: lastProject ? [{ action: 'resume-project', title: `Resume ${lastProject.name}` }] : [],
    data: { projectId: lastProject?.id ?? null },
  };
}

// ---- Being active ----

/** True if the user is at the computer. Without a detector there is nothing to say otherwise. */
export function isUserActive(idle: IdleSnapshot | null): boolean {
  return idle === null || (idle.user === 'active' && idle.screen === 'unlocked');
}

/** The check-in chime plays only for an active user (R7.6). */
export function shouldChime(idle: IdleSnapshot | null): boolean {
  return isUserActive(idle);
}

/** The one repeat of the "nothing is running" alert (R7.3): still nothing running, user active. */
export function shouldRepeatNothing(state: AppState | null, idle: IdleSnapshot | null): boolean {
  return state !== null && state.running === null && isUserActive(idle);
}

// ---- Server unreachable (R7.4), sound blocked (R8.2) ----

export const SERVER_DOWN_NOTIFICATION: AlertNotification = {
  title: "Work Hours server isn't running",
  body: "Time isn't being counted. Run workhours in a terminal to start it.",
  actions: [],
};

export const SOUND_BLOCKED_NOTIFICATION: AlertNotification = {
  title: 'Click in Work Hours to turn sound back on',
  body: 'Chrome blocks sound until you click in the page.',
  actions: [],
};

// ---- Health warnings (R8.3) ----

export type WarningId = 'server' | 'sound' | 'notifications' | 'away' | 'discarded';

export interface Warning {
  id: WarningId;
  text: string;
}

export interface HealthInputs {
  /** The live connection has been down for more than the grace period. */
  serverDown: boolean;
  soundUnlocked: boolean;
  notificationsGranted: boolean;
  awayDetectionGranted: boolean;
  /** Chrome unloaded this tab before it was loaded again. */
  discarded: boolean;
  /** `location.host`, for the Memory Saver setting. */
  host: string;
}

/** The failing checks, most important first. */
export function healthWarnings(input: HealthInputs): Warning[] {
  const warnings: Warning[] = [];
  if (input.serverDown) {
    warnings.push({
      id: 'server',
      text: "Work Hours server isn't running. Time isn't being counted.",
    });
  }
  if (!input.soundUnlocked) {
    warnings.push({ id: 'sound', text: 'Sound is off. Click to turn on.' });
  }
  if (!input.notificationsGranted) {
    warnings.push({
      id: 'notifications',
      text: "Notifications are off. Alerts can't reach you in the background.",
    });
  }
  if (!input.awayDetectionGranted) {
    warnings.push({
      id: 'away',
      text: "Away detection is off. The timer won't pause when you leave.",
    });
  }
  if (input.discarded) {
    warnings.push({
      id: 'discarded',
      text: `Chrome unloaded this tab. Add ${input.host} to "Always keep these sites active".`,
    });
  }
  return warnings;
}
