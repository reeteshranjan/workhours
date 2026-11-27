import { describe, expect, it } from 'vitest';
import type { Tracker } from '../../server/tracker/index.js';
import type { AutoReason } from '../../shared/types.js';
import {
  MIN,
  T0,
  autoPauseRow,
  expectTrackerError,
  lastActionMeta,
  makeTracker,
  rows,
  sessions,
} from './helpers.js';

const HOUR = 60 * MIN;

/** Current of an active project as of `now`. */
function currentOf(t: Tracker, now: number, projectId: number): number {
  const found = t.getState(now).projects.find((p) => p.id === projectId);
  if (!found) throw new Error(`Project ${projectId} is not active`);
  return found.currentMs;
}

/** When and why the latest session of an active project ended, as of `now`. */
function lastPauseOf(t: Tracker, now: number, projectId: number) {
  const found = t.getState(now).projects.find((p) => p.id === projectId);
  if (!found) throw new Error(`Project ${projectId} is not active`);
  return found.lastPause;
}

describe('backdate: switch', () => {
  it('moves the boundary between the two sessions, and can be done again', () => {
    const { t, db } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    const b = t.addProject(T0, 'B').id;
    t.start(T0, a);
    t.start(T0 + 60 * MIN, b);
    const now = T0 + 60 * MIN;
    expect(currentOf(t, now, a)).toBe(60 * MIN);
    expect(currentOf(t, now, b)).toBe(0);

    t.backdate(now, T0 + 50 * MIN);
    expect(sessions(db)).toMatchObject([
      { id: 1, started_at: T0, ended_at: T0 + 50 * MIN, end_reason: 'switch' },
      { id: 2, started_at: T0 + 50 * MIN, ended_at: null, end_reason: null },
    ]);
    expect(currentOf(t, now, a)).toBe(50 * MIN);
    expect(currentOf(t, now, b)).toBe(10 * MIN);

    // The click time never changes, so the range is still [earliest, click time].
    expect(t.getState(now).lastAction).toEqual({ kind: 'switch', at: now, earliest: T0 });
    t.backdate(now + MIN, T0 + 55 * MIN);
    expect(sessions(db)).toMatchObject([
      { ended_at: T0 + 55 * MIN },
      { started_at: T0 + 55 * MIN },
    ]);
    expect(currentOf(t, now + MIN, a)).toBe(55 * MIN);
    expect(currentOf(t, now + MIN, b)).toBe(6 * MIN);

    // Back to the click time itself is allowed.
    t.backdate(now + MIN, now);
    expect(sessions(db)).toMatchObject([{ ended_at: now }, { started_at: now }]);
  });

  it('rejects a time after the click or before the first session started', () => {
    const { t, db } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    const b = t.addProject(T0, 'B').id;
    t.start(T0, a);
    t.start(T0 + 60 * MIN, b);
    const later = T0 + 62 * MIN;

    expectTrackerError(() => t.backdate(later, T0 + 61 * MIN), 'backdate_out_of_range');
    expectTrackerError(() => t.backdate(later, T0 - 1), 'backdate_out_of_range');
    expectTrackerError(() => t.backdate(later, T0 - 30 * MIN), 'backdate_out_of_range');
    const error = expectTrackerError(
      () => t.backdate(later, T0 + 61 * MIN),
      'backdate_out_of_range',
    );
    expect(error.message).toBe('That time is out of range.');
    // Nothing moved.
    expect(sessions(db)).toMatchObject([
      { started_at: T0, ended_at: T0 + 60 * MIN },
      { started_at: T0 + 60 * MIN, ended_at: null },
    ]);
  });

  it('never goes later than now', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.pause(T0 + 10 * MIN);
    // A clock that moved back: the click is "in the future".
    expectTrackerError(() => t.backdate(T0 + 9 * MIN, T0 + 10 * MIN), 'backdate_out_of_range');
    t.backdate(T0 + 9 * MIN, T0 + 9 * MIN);
  });

  it('is bounded so Current does not go below zero', () => {
    const { t, db } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    const b = t.addProject(T0, 'B').id;
    t.start(T0, a);
    t.adjust(T0 + 30 * MIN, a, -20, 'wrong project');
    t.start(T0 + 31 * MIN, b);
    const now = T0 + 31 * MIN;
    expect(currentOf(t, now, a)).toBe(11 * MIN);
    expect(t.getState(now).lastAction).toEqual({
      kind: 'switch',
      at: now,
      earliest: T0 + 20 * MIN,
    });

    expectTrackerError(() => t.backdate(now, T0 + 19 * MIN), 'backdate_out_of_range');
    t.backdate(now, T0 + 20 * MIN);
    expect(currentOf(t, now, a)).toBe(0);
    expect(sessions(db)[0]).toMatchObject({ ended_at: T0 + 20 * MIN });
    // Backdating does not move the bound.
    expect(t.getState(now).lastAction?.earliest).toBe(T0 + 20 * MIN);
  });
});

describe('backdate: pause', () => {
  it('moves the end of the session', () => {
    const { t, db } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.pause(T0 + 40 * MIN);
    const now = T0 + 41 * MIN;
    expect(t.getState(now).lastAction).toEqual({ kind: 'pause', at: T0 + 40 * MIN, earliest: T0 });

    t.backdate(now, T0 + 35 * MIN);
    expect(sessions(db)[0]).toMatchObject({ ended_at: T0 + 35 * MIN, end_reason: 'break' });
    expect(t.getState(now).paused).toEqual({
      since: T0 + 35 * MIN,
      reason: 'break',
      lastProjectId: a,
    });
    expect(currentOf(t, now, a)).toBe(35 * MIN);

    expectTrackerError(() => t.backdate(now, T0 + 41 * MIN), 'backdate_out_of_range');
    expectTrackerError(() => t.backdate(now, T0 - MIN), 'backdate_out_of_range');
  });

  it('is bounded so Current does not go below zero', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.adjust(T0 + 30 * MIN, a, -20, 'wrong project');
    t.pause(T0 + 31 * MIN);
    const now = T0 + 31 * MIN;
    expect(t.getState(now).lastAction?.earliest).toBe(T0 + 20 * MIN);
    expectTrackerError(() => t.backdate(now, T0 + 19 * MIN), 'backdate_out_of_range');
    t.backdate(now, T0 + 20 * MIN);
    expect(currentOf(t, now, a)).toBe(0);
  });
});

describe('backdate: plain start', () => {
  it('cannot go before the last stop', () => {
    const { t, db } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    const b = t.addProject(T0, 'B').id;
    t.start(T0, a);
    t.pause(T0 + 10 * MIN);
    t.start(T0 + 30 * MIN, b);
    const now = T0 + 30 * MIN;
    expect(t.getState(now).lastAction).toEqual({ kind: 'start', at: now, earliest: T0 + 10 * MIN });

    t.backdate(now, T0 + 12 * MIN);
    expect(sessions(db)[1]).toMatchObject({ started_at: T0 + 12 * MIN, ended_at: null });
    expect(currentOf(t, now, b)).toBe(18 * MIN);

    expectTrackerError(() => t.backdate(now, T0 + 9 * MIN), 'backdate_out_of_range');
    expectTrackerError(() => t.backdate(now, T0 + 10 * MIN - 1), 'backdate_out_of_range');
    expectTrackerError(() => t.backdate(now + 5 * MIN, now + MIN), 'backdate_out_of_range');
    t.backdate(now, T0 + 10 * MIN);
    expect(sessions(db)[1]).toMatchObject({ started_at: T0 + 10 * MIN });
    expect(sessions(db)[0]).toMatchObject({ ended_at: T0 + 10 * MIN });
  });

  it('uses the latest stop of any session', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    const b = t.addProject(T0, 'B').id;
    t.start(T0, a);
    t.pause(T0 + 10 * MIN);
    t.start(T0 + 12 * MIN, b);
    t.pause(T0 + 20 * MIN);
    t.start(T0 + 30 * MIN, a);
    expect(t.getState(T0 + 30 * MIN).lastAction?.earliest).toBe(T0 + 20 * MIN);
  });

  it('can go back 12 hours for the very first start, and no further', () => {
    const { t, db } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    expect(t.getState(T0).lastAction).toEqual({ kind: 'start', at: T0, earliest: T0 - 12 * HOUR });

    expectTrackerError(() => t.backdate(T0, T0 - 12 * HOUR - 1), 'backdate_out_of_range');
    t.backdate(T0, T0 - 12 * HOUR);
    expect(sessions(db)[0]).toMatchObject({ started_at: T0 - 12 * HOUR });
    expect(currentOf(t, T0, a)).toBe(12 * HOUR);
    // The bound is still measured from the click.
    expect(t.getState(T0).lastAction?.earliest).toBe(T0 - 12 * HOUR);
  });
});

describe('backdate: input and availability', () => {
  it('needs a whole number of milliseconds', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    expectTrackerError(() => t.backdate(T0, T0 - 0.5), 'invalid_input');
    expectTrackerError(() => t.backdate(T0, Number.NaN), 'invalid_input');
    expectTrackerError(
      () => t.backdate(T0, String(T0 - MIN) as unknown as number),
      'invalid_input',
    );
  });

  it('is unavailable when nothing has been done', () => {
    const { t } = makeTracker();
    const error = expectTrackerError(() => t.backdate(T0, T0), 'backdate_unavailable');
    expect(error.message).toBe("There's nothing to move back.");
  });

  it.each<[string, (t: Tracker, a: number) => unknown]>([
    ['reset', (t, a) => t.reset(T0 + 5 * MIN, a)],
    ['adjust', (t, a) => t.adjust(T0 + 5 * MIN, a, 5, 'why')],
    ['close', (t, a) => t.close(T0 + 5 * MIN, a)],
    ['autoPause', (t) => t.autoPause(T0 + 5 * MIN, 'locked', T0 + 4 * MIN)],
  ])('is unavailable after %s following a start', (_label, act) => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    expect(t.getState(T0).lastAction).not.toBeNull();
    act(t, a);
    expect(t.getState(T0 + 6 * MIN).lastAction).toBeNull();
    expectTrackerError(() => t.backdate(T0 + 6 * MIN, T0), 'backdate_unavailable');
  });

  it.each<[string, (t: Tracker) => unknown]>([
    ['countAway', (t) => t.countAway(T0 + 20 * MIN, 1)],
    ['dismissAway', (t) => t.dismissAway(T0 + 20 * MIN, 1)],
  ])('is unavailable after %s following a start', (_label, act) => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    const b = t.addProject(T0, 'B').id;
    t.start(T0, a);
    t.autoPause(T0 + 5 * MIN, 'locked', T0 + 5 * MIN);
    t.start(T0 + 10 * MIN, b);
    expect(t.getState(T0 + 10 * MIN).lastAction).not.toBeNull();
    act(t);
    expect(t.getState(T0 + 21 * MIN).lastAction).toBeNull();
    expectTrackerError(() => t.backdate(T0 + 21 * MIN, T0 + 10 * MIN), 'backdate_unavailable');
  });

  it('is unavailable after reopen', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    const b = t.addProject(T0, 'B').id;
    t.close(T0, b);
    t.start(T0 + MIN, a);
    t.reopen(T0 + 2 * MIN, b);
    expectTrackerError(() => t.backdate(T0 + 3 * MIN, T0 + MIN), 'backdate_unavailable');
  });

  it('only applies to the latest start', () => {
    const { t, db } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    const b = t.addProject(T0, 'B').id;
    t.start(T0, a);
    t.start(T0 + 10 * MIN, b);
    const now = T0 + 10 * MIN;
    // The first start can't be moved any more: this is a switch, bounded by A's start.
    expect(t.getState(now).lastAction).toEqual({ kind: 'switch', at: now, earliest: T0 });
    expectTrackerError(() => t.backdate(now, T0 - MIN), 'backdate_out_of_range');
    t.backdate(now, T0 + 5 * MIN);
    expect(sessions(db)[0]).toMatchObject({ started_at: T0 });
  });

  it('is kept by a start or pause that does nothing, and by markReturned and touchAlive', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.start(T0 + MIN, a);
    t.markReturned(T0 + 2 * MIN, T0 + 2 * MIN);
    t.touchAlive(T0 + 2 * MIN);
    expect(t.getState(T0 + 2 * MIN).lastAction).toEqual({
      kind: 'start',
      at: T0,
      earliest: T0 - 12 * HOUR,
    });
  });

  describe('when the sessions no longer look the way the action left them', () => {
    it('after a switch whose old session ended some other way', () => {
      const { t, db } = makeTracker();
      const a = t.addProject(T0, 'A').id;
      const b = t.addProject(T0, 'B').id;
      t.start(T0, a);
      t.start(T0 + 10 * MIN, b);
      db.prepare("UPDATE sessions SET end_reason = 'break' WHERE id = 1").run();
      expect(t.getState(T0 + 11 * MIN).lastAction).toBeNull();
      expectTrackerError(() => t.backdate(T0 + 11 * MIN, T0 + 5 * MIN), 'backdate_unavailable');
      // Stale, so it is forgotten for good, not just rejected.
      expect(lastActionMeta(db)).toBeUndefined();
    });

    it('after a start whose session is no longer running', () => {
      const { t, db } = makeTracker();
      const a = t.addProject(T0, 'A').id;
      t.start(T0, a);
      db.prepare("UPDATE sessions SET ended_at = ?, end_reason = 'break' WHERE id = 1").run(
        T0 + MIN,
      );
      expect(t.getState(T0 + 2 * MIN).lastAction).toBeNull();
      expectTrackerError(() => t.backdate(T0 + 2 * MIN, T0), 'backdate_unavailable');
      expect(lastActionMeta(db)).toBeUndefined();
    });

    it('after a pause when something is running again', () => {
      const { t, db } = makeTracker();
      const a = t.addProject(T0, 'A').id;
      t.start(T0, a);
      t.pause(T0 + 10 * MIN);
      db.prepare('INSERT INTO sessions (project_id, started_at) VALUES (?, ?)').run(
        a,
        T0 + 11 * MIN,
      );
      expect(t.getState(T0 + 12 * MIN).lastAction).toBeNull();
      expectTrackerError(() => t.backdate(T0 + 12 * MIN, T0 + 5 * MIN), 'backdate_unavailable');
      expect(lastActionMeta(db)).toBeUndefined();
    });

    it('getState alone does not forget it', () => {
      const { t, db } = makeTracker();
      const a = t.addProject(T0, 'A').id;
      t.start(T0, a);
      t.pause(T0 + 10 * MIN);
      db.prepare('INSERT INTO sessions (project_id, started_at) VALUES (?, ?)').run(
        a,
        T0 + 11 * MIN,
      );
      expect(t.getState(T0 + 12 * MIN).lastAction).toBeNull();
      expect(lastActionMeta(db)).toBeDefined();
    });

    it('when the stored value is garbage', () => {
      const { t, db } = makeTracker();
      db.prepare("INSERT INTO app_meta (key, value) VALUES ('last_action', 'not json')").run();
      expect(t.getState(T0).lastAction).toBeNull();
      expectTrackerError(() => t.backdate(T0, T0), 'backdate_unavailable');
      expect(lastActionMeta(db)).toBeUndefined();
    });
  });
});

describe('getState.lastAction', () => {
  it('exposes kind, at and earliest, and nothing else', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    const b = t.addProject(T0, 'B').id;
    expect(t.getState(T0).lastAction).toBeNull();

    t.start(T0, a);
    expect(t.getState(T0).lastAction).toStrictEqual({
      kind: 'start',
      at: T0,
      earliest: T0 - 12 * HOUR,
    });

    t.start(T0 + 15 * MIN, b);
    expect(t.getState(T0 + 15 * MIN).lastAction).toStrictEqual({
      kind: 'switch',
      at: T0 + 15 * MIN,
      earliest: T0,
    });

    t.pause(T0 + 20 * MIN);
    expect(t.getState(T0 + 20 * MIN).lastAction).toStrictEqual({
      kind: 'pause',
      at: T0 + 20 * MIN,
      earliest: T0 + 15 * MIN,
    });
  });

  it('is null after an action that invalidates it', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.pause(T0 + 10 * MIN);
    expect(t.getState(T0 + 10 * MIN).lastAction).not.toBeNull();
    t.reset(T0 + 11 * MIN, a);
    expect(t.getState(T0 + 11 * MIN).lastAction).toBeNull();
  });
});

describe('autoPause', () => {
  it.each<AutoReason>(['tab_closed', 'sleep', 'stopped', 'locked', 'idle'])(
    'ends the session at the given time with reason %s',
    (reason) => {
      const { t, db } = makeTracker();
      const a = t.addProject(T0, 'A').id;
      t.start(T0, a);
      const notice = t.autoPause(T0 + 20 * MIN, reason, T0 + 15 * MIN);

      const expected = {
        sessionId: 1,
        projectId: a,
        projectName: 'A',
        reason,
        pausedAt: T0 + 15 * MIN,
        returnedAt: null,
        nextStartedAt: null,
      };
      expect(notice).toEqual(expected);
      expect(sessions(db)[0]).toMatchObject({ ended_at: T0 + 15 * MIN, end_reason: reason });
      expect(autoPauseRow(db, 1)).toEqual({
        detected_at: T0 + 20 * MIN,
        returned_at: null,
        resolution: null,
        resolved_at: null,
      });

      const state = t.getState(T0 + 20 * MIN);
      expect(state.running).toBeNull();
      expect(state.awayNotices).toEqual([expected]);
      expect(state.paused).toEqual({ since: T0 + 15 * MIN, reason, lastProjectId: a });
      expect(lastActionMeta(db)).toBeUndefined();
    },
  );

  it('clamps a time before the session started to its start', () => {
    const { t, db } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0 + 10 * MIN, a);
    const notice = t.autoPause(T0 + 20 * MIN, 'sleep', T0);
    expect(notice?.pausedAt).toBe(T0 + 10 * MIN);
    expect(sessions(db)[0]).toMatchObject({ started_at: T0 + 10 * MIN, ended_at: T0 + 10 * MIN });
  });

  it('clamps a time in the future to now', () => {
    const { t, db } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    const notice = t.autoPause(T0 + 20 * MIN, 'idle', T0 + 60 * MIN);
    expect(notice?.pausedAt).toBe(T0 + 20 * MIN);
    expect(sessions(db)[0]).toMatchObject({ ended_at: T0 + 20 * MIN });
  });

  it('does nothing and returns null when nothing is running', () => {
    const { t, db } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    expect(t.autoPause(T0, 'locked', T0)).toBeNull();

    t.start(T0, a);
    t.pause(T0 + 5 * MIN);
    expect(t.autoPause(T0 + 6 * MIN, 'idle', T0 + 5 * MIN)).toBeNull();
    expect(rows(db, 'SELECT * FROM auto_pauses')).toEqual([]);
    expect(t.getState(T0 + 6 * MIN).paused?.reason).toBe('break');
    // It ended nothing, so the pause can still be backdated.
    expect(lastActionMeta(db)).toMatchObject({ kind: 'pause' });
  });

  it('can pause a session that Count it reopened, as a new pending notice', () => {
    const { t, db } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.autoPause(T0 + 30 * MIN, 'locked', T0 + 30 * MIN);
    t.markReturned(T0 + 31 * MIN, T0 + 31 * MIN);
    t.countAway(T0 + 40 * MIN, 1);
    expect(autoPauseRow(db, 1)?.resolution).toBe('counted');

    const notice = t.autoPause(T0 + 50 * MIN, 'idle', T0 + 45 * MIN);
    expect(notice).toEqual({
      sessionId: 1,
      projectId: a,
      projectName: 'A',
      reason: 'idle',
      pausedAt: T0 + 45 * MIN,
      returnedAt: null,
      nextStartedAt: null,
    });
    expect(autoPauseRow(db, 1)).toEqual({
      detected_at: T0 + 50 * MIN,
      returned_at: null,
      resolution: null,
      resolved_at: null,
    });
    expect(t.getState(T0 + 50 * MIN).awayNotices).toEqual([notice]);
  });
});

describe('markReturned', () => {
  it('stamps pending notices only, and not twice', () => {
    const { t, db } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    const b = t.addProject(T0, 'B').id;
    // 1: resolved without ever returning.
    t.start(T0, a);
    t.autoPause(T0 + 10 * MIN, 'locked', T0 + 10 * MIN);
    t.dismissAway(T0 + 11 * MIN, 1);
    // 2: pending, then returned.
    t.start(T0 + 12 * MIN, b);
    t.autoPause(T0 + 20 * MIN, 'idle', T0 + 20 * MIN);
    expect(t.markReturned(T0 + 21 * MIN, T0 + 21 * MIN)).toEqual([2]);
    // 3: pending and new.
    t.start(T0 + 22 * MIN, a);
    t.autoPause(T0 + 30 * MIN, 'locked', T0 + 30 * MIN);
    expect(t.markReturned(T0 + 40 * MIN, T0 + 39 * MIN)).toEqual([3]);

    expect(autoPauseRow(db, 1)?.returned_at).toBeNull();
    expect(autoPauseRow(db, 2)?.returned_at).toBe(T0 + 21 * MIN);
    expect(autoPauseRow(db, 3)?.returned_at).toBe(T0 + 39 * MIN);
    expect(t.getState(T0 + 41 * MIN).awayNotices.map((n) => [n.sessionId, n.returnedAt])).toEqual([
      [2, T0 + 21 * MIN],
      [3, T0 + 39 * MIN],
    ]);
    expect(t.markReturned(T0 + 41 * MIN, T0 + 41 * MIN)).toEqual([]);
  });

  it('returns several session ids in ascending order, and keeps the time from passing now', () => {
    const { t, db } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    const b = t.addProject(T0, 'B').id;
    t.start(T0, a);
    t.autoPause(T0 + 10 * MIN, 'locked', T0 + 10 * MIN);
    t.start(T0 + 12 * MIN, b);
    t.autoPause(T0 + 20 * MIN, 'idle', T0 + 20 * MIN);
    expect(t.markReturned(T0 + 30 * MIN, T0 + 90 * MIN)).toEqual([1, 2]);
    expect(autoPauseRow(db, 1)?.returned_at).toBe(T0 + 30 * MIN);
    expect(autoPauseRow(db, 2)?.returned_at).toBe(T0 + 30 * MIN);
  });
});

describe('countAway', () => {
  it('carries the timer on when nothing has started since', () => {
    const { t, db } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.autoPause(T0 + 30 * MIN, 'locked', T0 + 30 * MIN);
    expect(t.getState(T0 + 75 * MIN).awayNotices).toHaveLength(1);

    t.countAway(T0 + 75 * MIN, 1);
    const state = t.getState(T0 + 80 * MIN);
    expect(state.running).toEqual({ projectId: a, sessionId: 1, startedAt: T0 });
    expect(state.paused).toBeNull();
    expect(state.awayNotices).toEqual([]);
    expect(currentOf(t, T0 + 80 * MIN, a)).toBe(80 * MIN);
    expect(sessions(db)[0]).toMatchObject({ ended_at: null, end_reason: null });
    expect(autoPauseRow(db, 1)).toMatchObject({
      resolution: 'counted',
      resolved_at: T0 + 75 * MIN,
    });
    expect(lastActionMeta(db)).toBeUndefined();
  });

  it('ends the session where the next one started when something started since', () => {
    const { t, db } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    const b = t.addProject(T0, 'B').id;
    t.start(T0, a);
    t.autoPause(T0 + 30 * MIN, 'locked', T0 + 30 * MIN);
    t.start(T0 + 75 * MIN, b);

    t.countAway(T0 + 90 * MIN, 1);
    expect(sessions(db)).toMatchObject([
      { id: 1, ended_at: T0 + 75 * MIN, end_reason: 'locked' },
      { id: 2, started_at: T0 + 75 * MIN, ended_at: null },
    ]);
    const state = t.getState(T0 + 90 * MIN);
    expect(state.running).toEqual({ projectId: b, sessionId: 2, startedAt: T0 + 75 * MIN });
    expect(currentOf(t, T0 + 90 * MIN, a)).toBe(75 * MIN);
    expect(currentOf(t, T0 + 90 * MIN, b)).toBe(15 * MIN);
    expect(state.awayNotices).toEqual([]);
    expect(autoPauseRow(db, 1)?.resolution).toBe('counted');
  });

  it('uses the first session that started after, not a later one', () => {
    const { t, db } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    const b = t.addProject(T0, 'B').id;
    const c = t.addProject(T0, 'C').id;
    t.start(T0, a);
    t.autoPause(T0 + 30 * MIN, 'locked', T0 + 30 * MIN);
    t.start(T0 + 75 * MIN, b);
    t.start(T0 + 80 * MIN, c);
    t.countAway(T0 + 90 * MIN, 1);
    expect(sessions(db)[0]).toMatchObject({ ended_at: T0 + 75 * MIN });
    expect(sessions(db)[1]).toMatchObject({ started_at: T0 + 75 * MIN, ended_at: T0 + 80 * MIN });
  });
});

describe('resumeAfterAway', () => {
  it('starts the project again from now, without the time away', () => {
    const { t, db } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.autoPause(T0 + 30 * MIN, 'locked', T0 + 30 * MIN);

    t.resumeAfterAway(T0 + 75 * MIN, 1);
    expect(sessions(db)).toMatchObject([
      { id: 1, started_at: T0, ended_at: T0 + 30 * MIN, end_reason: 'locked' },
      { id: 2, project_id: a, started_at: T0 + 75 * MIN, ended_at: null },
    ]);
    const state = t.getState(T0 + 80 * MIN);
    expect(state.running).toEqual({ projectId: a, sessionId: 2, startedAt: T0 + 75 * MIN });
    expect(state.awayNotices).toEqual([]);
    expect(currentOf(t, T0 + 80 * MIN, a)).toBe(35 * MIN);
    expect(autoPauseRow(db, 1)).toMatchObject({
      resolution: 'resumed',
      resolved_at: T0 + 75 * MIN,
    });
    // The fresh last action from start() survives the clearing.
    expect(state.lastAction).toEqual({ kind: 'start', at: T0 + 75 * MIN, earliest: T0 + 30 * MIN });
  });

  it('can be backdated like any start', () => {
    const { t, db } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.autoPause(T0 + 30 * MIN, 'locked', T0 + 30 * MIN);
    t.resumeAfterAway(T0 + 75 * MIN, 1);
    t.backdate(T0 + 75 * MIN, T0 + 60 * MIN);
    expect(sessions(db)[1]).toMatchObject({ started_at: T0 + 60 * MIN });
    expectTrackerError(() => t.backdate(T0 + 75 * MIN, T0 + 29 * MIN), 'backdate_out_of_range');
  });

  it('switches when another project is running', () => {
    const { t, db } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    const b = t.addProject(T0, 'B').id;
    t.start(T0, a);
    t.autoPause(T0 + 30 * MIN, 'locked', T0 + 30 * MIN);
    t.start(T0 + 40 * MIN, b);

    t.resumeAfterAway(T0 + 50 * MIN, 1);
    expect(sessions(db)).toMatchObject([
      { id: 1, ended_at: T0 + 30 * MIN },
      { id: 2, project_id: b, ended_at: T0 + 50 * MIN, end_reason: 'switch' },
      { id: 3, project_id: a, started_at: T0 + 50 * MIN, ended_at: null },
    ]);
    expect(t.getState(T0 + 50 * MIN).lastAction).toEqual({
      kind: 'switch',
      at: T0 + 50 * MIN,
      earliest: T0 + 40 * MIN,
    });
  });

  it('changes nothing when the project can not start', () => {
    const { t, db } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.autoPause(T0 + 30 * MIN, 'locked', T0 + 30 * MIN);
    db.prepare("UPDATE projects SET status = 'closed', closed_at = ? WHERE id = ?").run(T0, a);
    expectTrackerError(() => t.resumeAfterAway(T0 + 40 * MIN, 1), 'not_active');
    expect(autoPauseRow(db, 1)?.resolution).toBeNull();
  });
});

describe('dismissAway', () => {
  it('leaves the project paused and the time away uncounted', () => {
    const { t, db } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.autoPause(T0 + 30 * MIN, 'locked', T0 + 30 * MIN);

    t.dismissAway(T0 + 75 * MIN, 1);
    const state = t.getState(T0 + 80 * MIN);
    expect(state.running).toBeNull();
    expect(state.paused).toEqual({ since: T0 + 30 * MIN, reason: 'locked', lastProjectId: a });
    expect(state.awayNotices).toEqual([]);
    expect(state.lastAction).toBeNull();
    expect(currentOf(t, T0 + 80 * MIN, a)).toBe(30 * MIN);
    expect(autoPauseRow(db, 1)).toMatchObject({
      resolution: 'dismissed',
      resolved_at: T0 + 75 * MIN,
    });
    expect(sessions(db)).toHaveLength(1);
  });
});

describe('a notice can be handled once', () => {
  const actions: Record<string, (t: Tracker, sessionId: number) => void> = {
    count: (t, id) => t.countAway(T0 + 60 * MIN, id),
    resume: (t, id) => t.resumeAfterAway(T0 + 60 * MIN, id),
    dismiss: (t, id) => t.dismissAway(T0 + 60 * MIN, id),
  };
  const names = Object.keys(actions);
  const pairs = names.flatMap((first) => names.map((second): [string, string] => [first, second]));

  function pausedA(): Tracker {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.autoPause(T0 + 30 * MIN, 'locked', T0 + 30 * MIN);
    return t;
  }

  it.each(pairs)('%s then %s is not_pending', (first, second) => {
    const t = pausedA();
    actions[first]?.(t, 1);
    const error = expectTrackerError(() => actions[second]?.(t, 1), 'not_pending');
    expect(error.message).toBe('That notice has already been handled.');
  });

  it.each(names)('%s of an unknown session is not_pending', (name) => {
    const t = pausedA();
    expectTrackerError(() => actions[name]?.(t, 999), 'not_pending');
  });

  it.each(names)('%s of a session that was never auto-paused is not_pending', (name) => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.pause(T0 + 10 * MIN);
    expectTrackerError(() => actions[name]?.(t, 1), 'not_pending');
  });

  it.each(names)('%s of a withdrawn notice is not_pending', (name) => {
    const t = pausedA();
    t.reset(T0 + 40 * MIN, 1);
    expectTrackerError(() => actions[name]?.(t, 1), 'not_pending');
  });
});

describe('withdrawn notices', () => {
  it('reset withdraws the notice of the same project', () => {
    const { t, db } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.autoPause(T0 + 30 * MIN, 'locked', T0 + 30 * MIN);
    t.reset(T0 + 40 * MIN, a);
    expect(autoPauseRow(db, 1)).toMatchObject({
      resolution: 'withdrawn',
      resolved_at: T0 + 40 * MIN,
    });
    expect(t.getState(T0 + 40 * MIN).awayNotices).toEqual([]);
  });

  it('close withdraws the notice of the same project', () => {
    const { t, db } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.autoPause(T0 + 30 * MIN, 'locked', T0 + 30 * MIN);
    t.close(T0 + 40 * MIN, a);
    expect(autoPauseRow(db, 1)).toMatchObject({
      resolution: 'withdrawn',
      resolved_at: T0 + 40 * MIN,
    });
    expect(t.getState(T0 + 40 * MIN).awayNotices).toEqual([]);
  });

  it('leaves the notice of another project alone', () => {
    const { t, db } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    const b = t.addProject(T0, 'B').id;
    t.start(T0, a);
    t.autoPause(T0 + 30 * MIN, 'locked', T0 + 30 * MIN);
    t.start(T0 + 31 * MIN, b);
    t.autoPause(T0 + 40 * MIN, 'idle', T0 + 40 * MIN);

    t.reset(T0 + 50 * MIN, a);
    expect(autoPauseRow(db, 1)?.resolution).toBe('withdrawn');
    expect(autoPauseRow(db, 2)?.resolution).toBeNull();
    expect(t.getState(T0 + 50 * MIN).awayNotices.map((n) => n.sessionId)).toEqual([2]);
  });
});

describe('recoverFromCrash', () => {
  it('ends the open session at the last sign of life', () => {
    const { t, db } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.touchAlive(T0 + 20 * MIN);

    const notice = t.recoverFromCrash(T0 + 3 * HOUR);
    const expected = {
      sessionId: 1,
      projectId: a,
      projectName: 'A',
      reason: 'stopped',
      pausedAt: T0 + 20 * MIN,
      returnedAt: null,
      nextStartedAt: null,
    };
    expect(notice).toEqual(expected);
    expect(sessions(db)[0]).toMatchObject({ ended_at: T0 + 20 * MIN, end_reason: 'stopped' });
    expect(autoPauseRow(db, 1)?.detected_at).toBe(T0 + 3 * HOUR);
    expect(t.getState(T0 + 3 * HOUR).awayNotices).toEqual([expected]);
    expect(currentOf(t, T0 + 3 * HOUR, a)).toBe(20 * MIN);
  });

  it('uses the latest heartbeat', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.touchAlive(T0 + 5 * MIN);
    t.touchAlive(T0 + 25 * MIN);
    expect(t.recoverFromCrash(T0 + HOUR)?.pausedAt).toBe(T0 + 25 * MIN);
  });

  it('ends the session at its start when there was no heartbeat', () => {
    const { t, db } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    const notice = t.recoverFromCrash(T0 + HOUR);
    expect(notice?.pausedAt).toBe(T0);
    expect(sessions(db)[0]).toMatchObject({ ended_at: T0, end_reason: 'stopped' });
    expect(currentOf(t, T0 + HOUR, a)).toBe(0);
  });

  it('does not end a session before it started when the heartbeat is older', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.touchAlive(T0);
    t.start(T0 + 10 * MIN, a);
    expect(t.recoverFromCrash(T0 + HOUR)?.pausedAt).toBe(T0 + 10 * MIN);
  });

  it('does nothing when no session is open', () => {
    const { t, db } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    expect(t.recoverFromCrash(T0)).toBeNull();
    t.start(T0, a);
    t.pause(T0 + 10 * MIN);
    t.touchAlive(T0 + 11 * MIN);
    expect(t.recoverFromCrash(T0 + HOUR)).toBeNull();
    expect(rows(db, 'SELECT * FROM auto_pauses')).toEqual([]);
  });

  it('touchAlive stores the time as text under last_alive_at', () => {
    const { t, db } = makeTracker();
    t.touchAlive(T0 + MIN);
    expect(rows(db, "SELECT value FROM app_meta WHERE key = 'last_alive_at'")).toEqual([
      { value: String(T0 + MIN) },
    ]);
  });
});

describe('clock moved backwards', () => {
  it('ends an automatic pause at the session start instead of failing', () => {
    const { db, t } = makeTracker();
    const { id } = t.addProject(T0, 'Acme');
    t.start(T0, id);
    const notice = t.autoPause(T0 - 5 * MIN, 'stopped', T0 - 5 * MIN);
    expect(notice?.pausedAt).toBe(T0);
    expect(sessions(db)[0]).toMatchObject({ started_at: T0, ended_at: T0, end_reason: 'stopped' });
  });

  it('ends a paused or switched session at its start instead of failing', () => {
    const { db, t } = makeTracker();
    const a = t.addProject(T0, 'Acme').id;
    const b = t.addProject(T0, 'Blog').id;
    t.start(T0, a);
    t.start(T0 - 2 * MIN, b);
    t.pause(T0 - 3 * MIN);
    expect(sessions(db).map((s) => s.ended_at)).toEqual([T0, T0 - 2 * MIN]);
  });
});

describe('lastPause after an automatic pause', () => {
  it('is the backdated time and the automatic reason, and stays so after dismiss or reset', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.autoPause(T0 + 50 * MIN, 'locked', T0 + 30 * MIN);
    const expected = { at: T0 + 30 * MIN, reason: 'locked' };
    expect(lastPauseOf(t, T0 + 50 * MIN, a)).toEqual(expected);

    t.dismissAway(T0 + 60 * MIN, 1);
    expect(lastPauseOf(t, T0 + 60 * MIN, a)).toEqual(expected);

    // Reset withdraws a notice, but it does not change how the session ended.
    t.reset(T0 + 70 * MIN, a);
    expect(lastPauseOf(t, T0 + 70 * MIN, a)).toEqual(expected);
  });

  it('is null when Count it carries the timer on because nothing started since', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.autoPause(T0 + 30 * MIN, 'locked', T0 + 30 * MIN);
    t.countAway(T0 + 75 * MIN, 1);
    expect(lastPauseOf(t, T0 + 80 * MIN, a)).toBeNull();
  });

  it('reads as a switch when Count it ends the session where another project started', () => {
    const { t, db } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    const b = t.addProject(T0, 'B').id;
    t.start(T0, a);
    t.autoPause(T0 + 30 * MIN, 'locked', T0 + 30 * MIN);
    t.start(T0 + 75 * MIN, b);
    expect(lastPauseOf(t, T0 + 80 * MIN, a)).toEqual({ at: T0 + 30 * MIN, reason: 'locked' });

    t.countAway(T0 + 90 * MIN, 1);
    expect(lastPauseOf(t, T0 + 90 * MIN, a)).toEqual({ at: T0 + 75 * MIN, reason: 'switch' });
    expect(lastPauseOf(t, T0 + 90 * MIN, b)).toBeNull();
    // Only what the card shows changes: the record keeps the automatic reason.
    expect(sessions(db)[0]).toMatchObject({ ended_at: T0 + 75 * MIN, end_reason: 'locked' });
  });

  it('is null after Resume, because the project runs again', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.autoPause(T0 + 30 * MIN, 'locked', T0 + 30 * MIN);
    t.resumeAfterAway(T0 + 75 * MIN, 1);
    expect(lastPauseOf(t, T0 + 80 * MIN, a)).toBeNull();
  });

  it('shows the new reason when a session that Count it reopened is paused again automatically', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.autoPause(T0 + 30 * MIN, 'locked', T0 + 30 * MIN);
    t.countAway(T0 + 40 * MIN, 1);
    t.autoPause(T0 + 60 * MIN, 'idle', T0 + 55 * MIN);
    expect(lastPauseOf(t, T0 + 60 * MIN, a)).toEqual({ at: T0 + 55 * MIN, reason: 'idle' });
  });

  it("shows the user's own reason when a session that Count it reopened is then paused", () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.autoPause(T0 + 30 * MIN, 'locked', T0 + 30 * MIN);
    t.countAway(T0 + 40 * MIN, 1);
    t.pause(T0 + 50 * MIN);
    expect(lastPauseOf(t, T0 + 55 * MIN, a)).toEqual({ at: T0 + 50 * MIN, reason: 'break' });
  });

  it("shows the user's own reason when a session that Count it reopened is then reset or closed", () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    const b = t.addProject(T0, 'B').id;
    t.start(T0, a);
    t.autoPause(T0 + 30 * MIN, 'locked', T0 + 30 * MIN);
    t.countAway(T0 + 40 * MIN, 1);
    t.reset(T0 + 50 * MIN, a);
    expect(lastPauseOf(t, T0 + 55 * MIN, a)).toEqual({ at: T0 + 50 * MIN, reason: 'reset' });

    t.start(T0 + 60 * MIN, b);
    t.autoPause(T0 + 70 * MIN, 'idle', T0 + 70 * MIN);
    t.countAway(T0 + 75 * MIN, 2);
    t.close(T0 + 80 * MIN, b);
    t.reopen(T0 + 85 * MIN, b);
    expect(lastPauseOf(t, T0 + 90 * MIN, b)).toEqual({ at: T0 + 80 * MIN, reason: 'close' });
  });
});

describe('start answers a pending notice as Resume', () => {
  it("resolves the project's own notice as resumed, and the time away is not counted", () => {
    const { t, db } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.autoPause(T0 + 30 * MIN, 'locked', T0 + 30 * MIN);
    t.start(T0 + 75 * MIN, a);

    expect(autoPauseRow(db, 1)).toMatchObject({
      resolution: 'resumed',
      resolved_at: T0 + 75 * MIN,
    });
    expect(t.getState(T0 + 80 * MIN).awayNotices).toEqual([]);
    expect(currentOf(t, T0 + 80 * MIN, a)).toBe(35 * MIN);
  });

  it('leaves the notice pending when a different project starts, and says where Count would end the time away', () => {
    const { t, db } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    const b = t.addProject(T0, 'B').id;
    t.start(T0, a);
    t.autoPause(T0 + 30 * MIN, 'locked', T0 + 30 * MIN);
    t.start(T0 + 75 * MIN, b);

    expect(autoPauseRow(db, 1)).toMatchObject({ resolution: null, resolved_at: null });
    expect(t.getState(T0 + 80 * MIN).awayNotices).toMatchObject([
      { sessionId: 1, nextStartedAt: T0 + 75 * MIN },
    ]);
  });

  it('resolves the notice when the project is started again after another one ran', () => {
    const { t, db } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    const b = t.addProject(T0, 'B').id;
    t.start(T0, a);
    t.autoPause(T0 + 30 * MIN, 'locked', T0 + 30 * MIN);
    t.start(T0 + 40 * MIN, b);
    expect(autoPauseRow(db, 1)?.resolution).toBeNull();

    t.start(T0 + 50 * MIN, a);
    expect(autoPauseRow(db, 1)).toMatchObject({
      resolution: 'resumed',
      resolved_at: T0 + 50 * MIN,
    });
    expect(t.getState(T0 + 50 * MIN).awayNotices).toEqual([]);
  });

  it("resolves only the started project's notices", () => {
    const { t, db } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    const b = t.addProject(T0, 'B').id;
    t.start(T0, a);
    t.autoPause(T0 + 30 * MIN, 'locked', T0 + 30 * MIN);
    t.start(T0 + 40 * MIN, b);
    t.autoPause(T0 + 50 * MIN, 'idle', T0 + 50 * MIN);

    t.start(T0 + 60 * MIN, a);
    expect(autoPauseRow(db, 1)).toMatchObject({
      resolution: 'resumed',
      resolved_at: T0 + 60 * MIN,
    });
    expect(autoPauseRow(db, 2)).toMatchObject({ resolution: null, resolved_at: null });
    expect(t.getState(T0 + 60 * MIN).awayNotices.map((n) => n.sessionId)).toEqual([2]);
  });

  it('resolves the notice of a project that is already running, and changes nothing else', () => {
    const { t, db } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.autoPause(T0 + 30 * MIN, 'locked', T0 + 30 * MIN);
    // A session that started without answering the notice, as if by another route.
    db.prepare('INSERT INTO sessions (project_id, started_at) VALUES (?, ?)').run(a, T0 + 40 * MIN);
    const lastActionBefore = t.getState(T0 + 45 * MIN).lastAction;
    const metaBefore = lastActionMeta(db);

    t.start(T0 + 50 * MIN, a);

    expect(autoPauseRow(db, 1)).toMatchObject({
      resolution: 'resumed',
      resolved_at: T0 + 50 * MIN,
    });
    expect(t.getState(T0 + 50 * MIN).awayNotices).toEqual([]);
    expect(sessions(db)).toMatchObject([
      { id: 1, ended_at: T0 + 30 * MIN },
      { id: 2, started_at: T0 + 40 * MIN, ended_at: null, end_reason: null },
    ]);
    expect(t.getState(T0 + 50 * MIN).lastAction).toEqual(lastActionBefore);
    expect(lastActionMeta(db)).toEqual(metaBefore);
  });

  it('still lets "Started earlier?" count the time away', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.autoPause(T0 + 30 * MIN, 'locked', T0 + 30 * MIN);
    t.start(T0 + 75 * MIN, a);

    t.backdate(T0 + 76 * MIN, T0 + 30 * MIN);
    expect(currentOf(t, T0 + 80 * MIN, a)).toBe(80 * MIN);
  });
});

describe('nextStartedAt', () => {
  it('is null while nothing has started since the pause', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    const notice = t.autoPause(T0 + 30 * MIN, 'locked', T0 + 30 * MIN);
    expect(notice?.nextStartedAt).toBeNull();
    expect(t.getState(T0 + 40 * MIN).awayNotices).toMatchObject([{ nextStartedAt: null }]);
  });

  it('is where the first later session started, even after the later sessions have ended', () => {
    const { t, db } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    const b = t.addProject(T0, 'B').id;
    const c = t.addProject(T0, 'C').id;
    t.start(T0, a);
    t.autoPause(T0 + 30 * MIN, 'locked', T0 + 30 * MIN);
    t.start(T0 + 75 * MIN, b);
    t.start(T0 + 80 * MIN, c);
    t.pause(T0 + 90 * MIN);
    expect(sessions(db).map((s) => s.ended_at)).not.toContain(null);

    expect(t.getState(T0 + 95 * MIN).awayNotices).toMatchObject([
      { sessionId: 1, nextStartedAt: T0 + 75 * MIN },
    ]);
    // It is where Count ends the time away.
    t.countAway(T0 + 95 * MIN, 1);
    expect(sessions(db)[0]?.ended_at).toBe(T0 + 75 * MIN);
  });

  it('is still null after the user returns', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.autoPause(T0 + 30 * MIN, 'locked', T0 + 30 * MIN);
    t.markReturned(T0 + 45 * MIN, T0 + 45 * MIN);
    expect(t.getState(T0 + 50 * MIN).awayNotices).toMatchObject([
      { returnedAt: T0 + 45 * MIN, nextStartedAt: null },
    ]);
  });
});
