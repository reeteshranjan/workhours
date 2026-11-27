import { describe, expect, test } from 'vitest';
import type { AppState, AwayNotice, ProjectSummary } from '../../shared/types.js';
import { DEFAULT_SETTINGS } from '../../shared/types.js';
import {
  awayNotification,
  chooseReturnAlert,
  healthWarnings,
  isUserActive,
  lastProjectOf,
  latestReturnedNotice,
  nothingNotification,
  shouldChime,
  shouldRepeatNothing,
} from '../../web/src/lib/alerts/rules.js';
import type { HealthInputs, IdleSnapshot } from '../../web/src/lib/alerts/rules.js';
import { timeOfDay } from '../../web/src/lib/format.js';

const MINUTE = 60_000;

/** Local time, so the expected "14:02" is the same in any time zone. */
const PAUSED_AT = new Date(2026, 10, 23, 14, 2).getTime();
const NOW = PAUSED_AT + 2 * 60 * MINUTE;

const ACME: ProjectSummary = {
  id: 1,
  name: 'Acme Website',
  createdAt: 0,
  currentMs: 0,
  totalMs: 0,
  lastPause: null,
};
const BETA: ProjectSummary = {
  id: 2,
  name: 'Beta App',
  createdAt: 0,
  currentMs: 0,
  totalMs: 0,
  lastPause: null,
};

function notice(overrides: Partial<AwayNotice> = {}): AwayNotice {
  return {
    sessionId: 10,
    projectId: ACME.id,
    projectName: ACME.name,
    reason: 'locked',
    pausedAt: PAUSED_AT,
    returnedAt: PAUSED_AT + 45 * MINUTE,
    nextStartedAt: null,
    ...overrides,
  };
}

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    now: NOW,
    running: null,
    paused: { since: PAUSED_AT, reason: 'locked', lastProjectId: ACME.id },
    projects: [ACME, BETA],
    awayNotices: [],
    lastAction: null,
    settings: { ...DEFAULT_SETTINGS },
    ...overrides,
  };
}

const RUNNING = { projectId: ACME.id, sessionId: 11, startedAt: NOW - MINUTE };

const ACTIVE: IdleSnapshot = { user: 'active', screen: 'unlocked' };

describe('latestReturnedNotice', () => {
  test('is the returned notice with the highest session id', () => {
    const state = makeState({
      awayNotices: [
        notice({ sessionId: 12 }),
        notice({ sessionId: 14 }),
        notice({ sessionId: 13 }),
      ],
    });
    expect(latestReturnedNotice(state)?.sessionId).toBe(14);
  });

  test('skips notices the user has not come back from', () => {
    const state = makeState({
      awayNotices: [notice({ sessionId: 12 }), notice({ sessionId: 14, returnedAt: null })],
    });
    expect(latestReturnedNotice(state)?.sessionId).toBe(12);
  });

  test('is null with no notices or none returned', () => {
    expect(latestReturnedNotice(makeState())).toBeNull();
    expect(latestReturnedNotice(makeState({ awayNotices: [notice({ returnedAt: null })] }))).toBe(
      null,
    );
  });
});

describe('chooseReturnAlert', () => {
  test('picks the most recent returned notice', () => {
    const state = makeState({
      awayNotices: [notice({ sessionId: 3 }), notice({ sessionId: 7 }), notice({ sessionId: 5 })],
    });
    const choice = chooseReturnAlert(state);
    expect(choice?.kind).toBe('away');
    expect(choice?.kind === 'away' && choice.notice.sessionId).toBe(7);
  });

  test('the away alert wins over nothing-running', () => {
    const state = makeState({ running: null, awayNotices: [notice()] });
    expect(chooseReturnAlert(state)?.kind).toBe('away');
  });

  test('away alert is chosen even while something runs', () => {
    const state = makeState({ running: RUNNING, paused: null, awayNotices: [notice()] });
    expect(chooseReturnAlert(state)?.kind).toBe('away');
  });

  test('nothing-running is chosen when nothing runs and no notice has returned', () => {
    expect(chooseReturnAlert(makeState())).toEqual({ kind: 'nothing', lastProject: ACME });
    const stillAway = makeState({ awayNotices: [notice({ returnedAt: null })] });
    expect(chooseReturnAlert(stillAway)?.kind).toBe('nothing');
  });

  test('nothing-running carries no project when the last one was closed', () => {
    const state = makeState({ paused: { since: 0, reason: 'break', lastProjectId: null } });
    expect(chooseReturnAlert(state)).toEqual({ kind: 'nothing', lastProject: null });
  });

  test('nothing is chosen when a project runs and no notice has returned', () => {
    expect(chooseReturnAlert(makeState({ running: RUNNING, paused: null }))).toBeNull();
  });
});

describe('lastProjectOf', () => {
  test('finds the project that ran last', () => {
    const state = makeState({ paused: { since: 0, reason: 'break', lastProjectId: BETA.id } });
    expect(lastProjectOf(state)).toBe(BETA);
  });

  test('is null when nothing ran, or the project is gone', () => {
    expect(lastProjectOf(makeState({ paused: null }))).toBeNull();
    const closed = makeState({ paused: { since: 0, reason: 'close', lastProjectId: 99 } });
    expect(lastProjectOf(closed)).toBeNull();
  });
});

describe('awayNotification', () => {
  test('says what paused, when, why and for how long', () => {
    const n = awayNotification(notice(), NOW);
    expect(n.title).toBe(`Acme Website auto-paused ${timeOfDay(PAUSED_AT)}`);
    expect(n.body).toBe('screen locked · away 45m');
  });

  test('says "yesterday" for a pause on the previous day', () => {
    // Local times, so the previous day is the previous day in any time zone.
    const pausedAt = new Date(2026, 10, 22, 17, 45).getTime();
    const now = new Date(2026, 10, 23, 9, 30).getTime();
    const n = awayNotification(notice({ pausedAt, returnedAt: now }), now);
    expect(n.title).toBe('Acme Website auto-paused yesterday 17:45');
  });

  test('offers Count the duration and Resume, for the session', () => {
    const n = awayNotification(notice({ sessionId: 42 }), NOW);
    expect(n.actions).toEqual([
      { action: 'count', title: 'Count the 45m' },
      { action: 'resume', title: 'Resume' },
    ]);
    expect(n.data).toEqual({ sessionId: 42 });
  });

  test('formats long absences in hours and the reason in words', () => {
    const n = awayNotification(
      notice({ reason: 'sleep', returnedAt: PAUSED_AT + 3 * 60 * MINUTE + 12 * MINUTE }),
      NOW,
    );
    expect(n.body).toBe('computer slept · away 3h 12m');
    expect(n.actions[0]?.title).toBe('Count the 3h 12m');
  });

  test('uses the time given for a pause that has not returned yet', () => {
    const n = awayNotification(notice({ returnedAt: null }), PAUSED_AT + 10 * MINUTE);
    expect(n.body).toBe('screen locked · away 10m');
  });
});

describe('nothingNotification', () => {
  test('offers to resume the last project', () => {
    const n = nothingNotification(ACME);
    expect(n.title).toBe('Nothing is running');
    expect(n.body).toBe('Start a project to count your time.');
    expect(n.actions).toEqual([{ action: 'resume-project', title: 'Resume Acme Website' }]);
    expect(n.data).toEqual({ projectId: 1 });
  });

  test('has no button when there is no last project', () => {
    const n = nothingNotification(null);
    expect(n.actions).toEqual([]);
    expect(n.data).toEqual({ projectId: null });
  });
});

describe('isUserActive and shouldChime', () => {
  test('are true for an active, unlocked user', () => {
    expect(isUserActive(ACTIVE)).toBe(true);
    expect(shouldChime(ACTIVE)).toBe(true);
  });

  test('are true when no detector is running', () => {
    expect(shouldChime(null)).toBe(true);
  });

  test('are false for an idle user or a locked screen', () => {
    expect(shouldChime({ user: 'idle', screen: 'unlocked' })).toBe(false);
    expect(shouldChime({ user: 'active', screen: 'locked' })).toBe(false);
    expect(shouldChime({ user: 'idle', screen: 'locked' })).toBe(false);
  });
});

describe('shouldRepeatNothing', () => {
  test('repeats when nothing runs and the user is active', () => {
    expect(shouldRepeatNothing(makeState(), ACTIVE)).toBe(true);
    expect(shouldRepeatNothing(makeState(), null)).toBe(true);
  });

  test('does not repeat once something runs', () => {
    expect(shouldRepeatNothing(makeState({ running: RUNNING, paused: null }), ACTIVE)).toBe(false);
  });

  test('does not repeat for a user who is away again', () => {
    expect(shouldRepeatNothing(makeState(), { user: 'idle', screen: 'unlocked' })).toBe(false);
    expect(shouldRepeatNothing(makeState(), { user: 'active', screen: 'locked' })).toBe(false);
  });

  test('does not repeat without a state', () => {
    expect(shouldRepeatNothing(null, ACTIVE)).toBe(false);
  });
});

describe('healthWarnings', () => {
  const healthy: HealthInputs = {
    serverDown: false,
    soundUnlocked: true,
    notificationsGranted: true,
    awayDetectionGranted: true,
    discarded: false,
    host: 'localhost:7420',
  };

  test('has none when everything is protected', () => {
    expect(healthWarnings(healthy)).toEqual([]);
  });

  test('has the text of each failing check', () => {
    expect(healthWarnings({ ...healthy, serverDown: true })).toEqual([
      { id: 'server', text: "Work Hours server isn't running. Time isn't being counted." },
    ]);
    expect(healthWarnings({ ...healthy, soundUnlocked: false })).toEqual([
      { id: 'sound', text: 'Sound is off. Click to turn on.' },
    ]);
    expect(healthWarnings({ ...healthy, notificationsGranted: false })).toEqual([
      {
        id: 'notifications',
        text: "Notifications are off. Alerts can't reach you in the background.",
      },
    ]);
    expect(healthWarnings({ ...healthy, awayDetectionGranted: false })).toEqual([
      { id: 'away', text: "Away detection is off. The timer won't pause when you leave." },
    ]);
    expect(healthWarnings({ ...healthy, discarded: true })).toEqual([
      {
        id: 'discarded',
        text: 'Chrome unloaded this tab. Add localhost:7420 to "Always keep these sites active".',
      },
    ]);
  });

  test('orders them by priority', () => {
    const all = healthWarnings({
      serverDown: true,
      soundUnlocked: false,
      notificationsGranted: false,
      awayDetectionGranted: false,
      discarded: true,
      host: 'localhost:7420',
    });
    expect(all.map((w) => w.id)).toEqual(['server', 'sound', 'notifications', 'away', 'discarded']);
  });
});
