import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { Tracker } from '../../server/tracker/index.js';
import {
  CHECKIN_OPTIONS,
  DEFAULT_SETTINGS,
  MIN_VOLUME,
  type ProjectSummary,
} from '../../shared/types.js';
import { MIN, T0, expectTrackerError, makeTracker, rows } from './helpers.js';

interface SessionRow {
  id: number;
  project_id: number;
  started_at: number;
  ended_at: number | null;
  end_reason: string | null;
}

function sessions(db: DatabaseSync): SessionRow[] {
  return rows<SessionRow>(db, 'SELECT * FROM sessions ORDER BY id');
}

function project(t: Tracker, now: number, id: number): ProjectSummary {
  const found = t.getState(now).projects.find((p) => p.id === id);
  if (!found) throw new Error(`Project ${id} is not active`);
  return found;
}

function names(t: Tracker, now: number): string[] {
  return t.getState(now).projects.map((p) => p.name);
}

function lastActionMeta(db: DatabaseSync): unknown {
  const [row] = rows<{ value: string }>(db, "SELECT value FROM app_meta WHERE key = 'last_action'");
  return row ? JSON.parse(row.value) : undefined;
}

/** Stands in for autoPause (part B): ends the running session and records the pause. */
function fakeAutoPause(
  db: DatabaseSync,
  sessionId: number,
  reason: string,
  endedAt: number,
  returnedAt: number | null = null,
): void {
  db.prepare('UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ?').run(
    endedAt,
    reason,
    sessionId,
  );
  db.prepare('INSERT INTO auto_pauses (session_id, detected_at, returned_at) VALUES (?, ?, ?)').run(
    sessionId,
    endedAt + MIN,
    returnedAt,
  );
}

function autoPauseRow(db: DatabaseSync, sessionId: number) {
  return rows<{ resolution: string | null; resolved_at: number | null }>(
    db,
    'SELECT resolution, resolved_at FROM auto_pauses WHERE session_id = ?',
    sessionId,
  )[0];
}

/** Gives a project `minutes` of billed time without running a timer. */
function bill(t: Tracker, now: number, projectId: number, minutes: number): void {
  t.adjust(now, projectId, minutes, 'test');
  t.reset(now, projectId);
}

describe('project names', () => {
  it('trims the name', () => {
    const { t } = makeTracker();
    t.addProject(T0, '  Acme  ');
    expect(names(t, T0)).toEqual(['Acme']);
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['101 characters', 'a'.repeat(101)],
    ['a line break', 'a\nb'],
    ['a tab', 'a\tb'],
    ['not a string', 42],
    ['missing', undefined],
  ])('rejects a name that is %s', (_label, raw) => {
    const { t } = makeTracker();
    expectTrackerError(() => t.addProject(T0, raw), 'invalid_name');
    expect(names(t, T0)).toEqual([]);
  });

  it('says what is wrong with the name', () => {
    const { t } = makeTracker();
    expect(expectTrackerError(() => t.addProject(T0, ' '), 'invalid_name').message).toBe(
      'Enter a project name.',
    );
    expect(
      expectTrackerError(() => t.addProject(T0, 'a'.repeat(101)), 'invalid_name').message,
    ).toBe('Project names can be at most 100 characters.');
    expect(expectTrackerError(() => t.addProject(T0, 'a\nb'), 'invalid_name').message).toBe(
      "Project names can't contain line breaks or control characters.",
    );
  });

  it('accepts 100 characters', () => {
    const { t } = makeTracker();
    const { id } = t.addProject(T0, 'a'.repeat(100));
    expect(project(t, T0, id).name).toHaveLength(100);
  });

  it('counts characters, not UTF-16 units: 100 emoji are fine', () => {
    const { t } = makeTracker();
    t.addProject(T0, '😀'.repeat(100));
    expectTrackerError(() => t.addProject(T0, '😀'.repeat(101)), 'invalid_name');
  });

  it('rejects a name that differs only in letter case', () => {
    const { t } = makeTracker();
    t.addProject(T0, 'Acme');
    const err = expectTrackerError(() => t.addProject(T0, 'acme'), 'name_taken');
    expect(err.message).toBe('Acme already exists.');
    expect(names(t, T0)).toEqual(['Acme']);
  });

  it('keeps a closed project name reserved and says which project to reopen', () => {
    const { t } = makeTracker();
    const { id } = t.addProject(T0, 'Acme');
    t.close(T0, id);
    const err = expectTrackerError(() => t.addProject(T0, 'ACME'), 'name_taken_closed');
    expect(err.projectId).toBe(id);
    expect(err.message).toBe('A closed project is called Acme.');
  });

  it('folds case for non-English letters, which SQLite NOCASE would miss', () => {
    const { t } = makeTracker();
    t.addProject(T0, 'Σίσυφος');
    expectTrackerError(() => t.addProject(T0, 'ΣΊΣΥΦΟΣ'), 'name_taken');
  });

  it('maps a hit on the unique index to name_taken', () => {
    const { t } = makeTracker();
    t.addProject(T0, 'Acme');
    // Switch off the lowercase check so only the database index can catch the duplicate.
    const spy = vi.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(function (
      this: string,
    ) {
      return String(this);
    });
    try {
      const err = expectTrackerError(() => t.addProject(T0, 'ACME'), 'name_taken');
      expect(err.message).toBe('ACME already exists.');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('project order', () => {
  it('lists projects in the order they were added, whatever happens to them', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    const b = t.addProject(T0, 'B').id;
    t.addProject(T0, 'C');
    expect(names(t, T0)).toEqual(['A', 'B', 'C']);

    t.start(T0 + MIN, b);
    t.start(T0 + 2 * MIN, a);
    expect(names(t, T0 + 2 * MIN)).toEqual(['A', 'B', 'C']);

    t.close(T0 + 3 * MIN, b);
    expect(names(t, T0 + 3 * MIN)).toEqual(['A', 'C']);
    t.reopen(T0 + 4 * MIN, b);
    expect(names(t, T0 + 4 * MIN)).toEqual(['A', 'B', 'C']);
  });
});

describe('start, switch and pause', () => {
  it('starts, switches, ignores a repeated start, and pauses', () => {
    const { db, t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    const b = t.addProject(T0, 'B').id;

    t.start(T0, a);
    const running = t.getState(T0 + 10 * MIN);
    expect(running.running).toEqual({ projectId: a, sessionId: 1, startedAt: T0 });
    expect(running.paused).toBeNull();
    expect(project(t, T0 + 10 * MIN, a).currentMs).toBe(10 * MIN);

    t.start(T0 + 15 * MIN, b);
    expect(sessions(db)).toMatchObject([
      { id: 1, project_id: a, started_at: T0, ended_at: T0 + 15 * MIN, end_reason: 'switch' },
      { id: 2, project_id: b, started_at: T0 + 15 * MIN, ended_at: null, end_reason: null },
    ]);

    // Starting the running project again changes nothing.
    t.start(T0 + 16 * MIN, b);
    expect(sessions(db)).toHaveLength(2);
    expect(t.getState(T0 + 16 * MIN).running?.sessionId).toBe(2);

    t.pause(T0 + 20 * MIN);
    const paused = t.getState(T0 + 21 * MIN);
    expect(paused.running).toBeNull();
    expect(paused.paused).toEqual({ since: T0 + 20 * MIN, reason: 'break', lastProjectId: b });
    expect(sessions(db)[1]).toMatchObject({ ended_at: T0 + 20 * MIN, end_reason: 'break' });

    // Pausing again changes nothing.
    t.pause(T0 + 25 * MIN);
    expect(t.getState(T0 + 25 * MIN).paused?.since).toBe(T0 + 20 * MIN);
    expect(sessions(db)).toHaveLength(2);
  });

  it('starts a new session after a pause', () => {
    const { db, t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.pause(T0 + 10 * MIN);
    t.start(T0 + 30 * MIN, a);
    expect(sessions(db)).toHaveLength(2);
    expect(project(t, T0 + 40 * MIN, a).currentMs).toBe(20 * MIN);
  });

  it('refuses to start a closed or missing project', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.close(T0, a);
    expect(expectTrackerError(() => t.start(T0, a), 'not_active').message).toBe(
      'A is closed. Reopen it first.',
    );
    expect(expectTrackerError(() => t.start(T0, 999), 'not_found').message).toBe(
      "That project doesn't exist.",
    );
    expect(t.getState(T0).running).toBeNull();
  });

  it('reports no paused state before anything has run', () => {
    const { t } = makeTracker();
    t.addProject(T0, 'A');
    expect(t.getState(T0).paused).toBeNull();
  });
});

describe('lastPause', () => {
  it('is null for a project that never ran, and while it runs', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    expect(project(t, T0, a).lastPause).toBeNull();

    t.start(T0 + MIN, a);
    expect(project(t, T0 + 5 * MIN, a).lastPause).toBeNull();
  });

  it('is when and why a pause ended the session', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.pause(T0 + 20 * MIN);
    expect(project(t, T0 + 30 * MIN, a).lastPause).toEqual({ at: T0 + 20 * MIN, reason: 'break' });
  });

  it('reads as a switch on the project that was left, and is null on the one that started', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    const b = t.addProject(T0, 'B').id;
    t.start(T0, a);
    t.start(T0 + 15 * MIN, b);
    expect(project(t, T0 + 20 * MIN, a).lastPause).toEqual({ at: T0 + 15 * MIN, reason: 'switch' });
    expect(project(t, T0 + 20 * MIN, b).lastPause).toBeNull();
  });

  it('uses the latest session', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.pause(T0 + 10 * MIN);
    t.start(T0 + 20 * MIN, a);
    expect(project(t, T0 + 25 * MIN, a).lastPause).toBeNull();
    t.pause(T0 + 30 * MIN);
    expect(project(t, T0 + 40 * MIN, a).lastPause).toEqual({ at: T0 + 30 * MIN, reason: 'break' });
  });

  it('is the reset when a running project is reset, and stays put when a paused one is reset or adjusted', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.reset(T0 + 10 * MIN, a);
    const expected = { at: T0 + 10 * MIN, reason: 'reset' };
    expect(project(t, T0 + 11 * MIN, a).lastPause).toEqual(expected);

    t.adjust(T0 + 20 * MIN, a, 30, 'extra');
    expect(project(t, T0 + 21 * MIN, a).lastPause).toEqual(expected);
    t.reset(T0 + 30 * MIN, a);
    expect(project(t, T0 + 31 * MIN, a).lastPause).toEqual(expected);
  });

  it('survives closing and reopening a project that was running', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.close(T0 + 10 * MIN, a);
    t.reopen(T0 + 20 * MIN, a);
    expect(project(t, T0 + 30 * MIN, a).lastPause).toEqual({ at: T0 + 10 * MIN, reason: 'close' });
  });

  it('follows a backdated pause', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.pause(T0 + 30 * MIN);
    t.backdate(T0 + 31 * MIN, T0 + 20 * MIN);
    expect(project(t, T0 + 40 * MIN, a).lastPause).toEqual({ at: T0 + 20 * MIN, reason: 'break' });
  });
});

describe('current and total', () => {
  it('count a running session up to now', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    expect(project(t, T0 + 5 * MIN, a)).toMatchObject({ currentMs: 5 * MIN, totalMs: 5 * MIN });
    expect(project(t, T0 + 9 * MIN, a)).toMatchObject({ currentMs: 9 * MIN, totalMs: 9 * MIN });
    t.adjust(T0 + 9 * MIN, a, 10, 'phone call');
    expect(project(t, T0 + 11 * MIN, a)).toMatchObject({ currentMs: 21 * MIN, totalMs: 21 * MIN });
  });

  it('stop growing when paused', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.pause(T0 + 5 * MIN);
    expect(project(t, T0 + 50 * MIN, a)).toMatchObject({ currentMs: 5 * MIN, totalMs: 5 * MIN });
  });

  it('sum all sessions of a project, not just the latest', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    const b = t.addProject(T0, 'B').id;
    t.start(T0, a);
    t.start(T0 + 10 * MIN, b);
    t.start(T0 + 15 * MIN, a);
    expect(project(t, T0 + 20 * MIN, a).currentMs).toBe(15 * MIN);
    expect(project(t, T0 + 20 * MIN, b).currentMs).toBe(5 * MIN);
  });
});

describe('reset', () => {
  it('records the whole minutes, keeps the seconds, and stops the timer', () => {
    const { db, t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    const now = T0 + 754 * MIN + 40_000; // 12h 34m 40s

    expect(t.reset(now, a)).toEqual({ hours: 12, minutes: 34 });

    expect(project(t, now, a)).toMatchObject({ currentMs: 40_000, totalMs: now - T0 });
    // Nothing more accrues: the session ended at the reset.
    expect(project(t, now + 60 * MIN, a)).toMatchObject({ currentMs: 40_000, totalMs: now - T0 });
    expect(t.getState(now).running).toBeNull();
    expect(sessions(db)[0]).toMatchObject({ ended_at: now, end_reason: 'reset' });
    expect(t.getHistory(a).entries).toEqual([{ kind: 'reset', id: 1, at: now, minutes: 754 }]);
  });

  it('resets a project that is not running, and leaves the running one alone', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    const b = t.addProject(T0, 'B').id;
    t.start(T0, a);
    t.start(T0 + 10 * MIN, b);
    expect(t.reset(T0 + 20 * MIN, a)).toEqual({ hours: 0, minutes: 10 });
    expect(t.getState(T0 + 20 * MIN).running?.projectId).toBe(b);
  });

  it('needs at least a minute, and a running timer keeps running when it fails', () => {
    const { db, t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);

    const err = expectTrackerError(() => t.reset(T0 + 59_999, a), 'too_little_time');
    expect(err.message).toBe('Reset needs at least 1 minute.');

    expect(t.getState(T0 + 59_999).running).toMatchObject({ projectId: a, startedAt: T0 });
    expect(sessions(db)).toMatchObject([{ ended_at: null, end_reason: null }]);
    expect(t.getHistory(a).entries).toEqual([]);
    expect(lastActionMeta(db)).toMatchObject({ kind: 'start' });

    // And it succeeds a moment later.
    expect(t.reset(T0 + MIN, a)).toEqual({ hours: 0, minutes: 1 });
  });

  it('refuses a missing or closed project', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.close(T0, a);
    expectTrackerError(() => t.reset(T0, a), 'not_active');
    expectTrackerError(() => t.reset(T0, 999), 'not_found');
  });
});

describe('adjust', () => {
  it('adds to current and total', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.pause(T0 + 60 * MIN);
    t.adjust(T0 + 61 * MIN, a, 30, 'Forgot to track the call');
    expect(project(t, T0 + 61 * MIN, a)).toMatchObject({ currentMs: 90 * MIN, totalMs: 90 * MIN });
    t.adjust(T0 + 62 * MIN, a, -20, 'Lunch was included');
    expect(project(t, T0 + 62 * MIN, a)).toMatchObject({ currentMs: 70 * MIN, totalMs: 70 * MIN });
  });

  it('refuses to take current below zero', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.adjust(T0, a, 30, 'seed');
    const err = expectTrackerError(() => t.adjust(T0, a, -40, 'too much'), 'would_go_negative');
    expect(err.message).toBe('That would take A below zero. Time already reset has been billed.');
    expect(project(t, T0, a).currentMs).toBe(30 * MIN);
    t.adjust(T0, a, -30, 'exactly everything');
    expect(project(t, T0, a).currentMs).toBe(0);
  });

  it('cannot reach into time that was already reset', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.reset(T0 + 60 * MIN, a);
    expectTrackerError(() => t.adjust(T0 + 61 * MIN, a, -1, 'oops'), 'would_go_negative');
  });

  it.each([
    ['zero', 0],
    ['a fraction', 1.5],
    ['a string', '5'],
    ['NaN', NaN],
    ['infinite', Infinity],
    ['too large', 100_001],
    ['too small', -100_001],
    ['missing', undefined],
  ])('rejects minutes that are %s', (_label, minutes) => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    const err = expectTrackerError(() => t.adjust(T0, a, minutes, 'why'), 'invalid_input');
    expect(err.message).toBe('Enter a whole number of minutes other than 0.');
    expect(t.getHistory(a).entries).toEqual([]);
  });

  it('accepts the largest allowed adjustment', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.adjust(T0, a, 100_000, 'big');
    expect(project(t, T0, a).currentMs).toBe(100_000 * MIN);
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['201 characters', 'a'.repeat(201)],
    ['a line break', 'a\nb'],
    ['not a string', 7],
  ])('rejects a reason that is %s', (_label, reason) => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    const err = expectTrackerError(() => t.adjust(T0, a, 5, reason), 'invalid_input');
    expect(err.message).toBe('Enter a reason (up to 200 characters).');
  });

  it('trims the reason and accepts 200 characters', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.adjust(T0, a, 5, '  fix  ');
    t.adjust(T0 + MIN, a, 5, 'a'.repeat(200));
    const [newest, oldest] = t.getHistory(a).entries;
    expect(oldest).toMatchObject({ reason: 'fix' });
    expect(newest).toMatchObject({ reason: 'a'.repeat(200) });
  });

  it('refuses a missing or closed project', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.close(T0, a);
    expectTrackerError(() => t.adjust(T0, a, 5, 'x'), 'not_active');
    expectTrackerError(() => t.adjust(T0, 999, 5, 'x'), 'not_found');
  });

  it('shows adjustments and resets together in history, newest first', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.pause(T0 + 60 * MIN);
    t.adjust(T0 + 61 * MIN, a, 30, 'first');
    t.reset(T0 + 62 * MIN, a);
    t.adjust(T0 + 63 * MIN, a, 5, 'second');

    const history = t.getHistory(a);
    expect(history).toMatchObject({ projectId: a, name: 'A' });
    expect(history.entries).toEqual([
      { kind: 'adjustment', id: 2, at: T0 + 63 * MIN, minutes: 5, reason: 'second' },
      { kind: 'reset', id: 1, at: T0 + 62 * MIN, minutes: 90 },
      { kind: 'adjustment', id: 1, at: T0 + 61 * MIN, minutes: 30, reason: 'first' },
    ]);
  });

  it('has history only for projects that exist', () => {
    const { t } = makeTracker();
    expectTrackerError(() => t.getHistory(999), 'not_found');
  });
});

describe('close and reopen', () => {
  it('stops the running project and moves it to the closed list', () => {
    const { db, t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.close(T0 + 30 * MIN, a);

    expect(sessions(db)[0]).toMatchObject({ ended_at: T0 + 30 * MIN, end_reason: 'close' });
    const state = t.getState(T0 + 40 * MIN);
    expect(state.running).toBeNull();
    expect(state.projects).toEqual([]);
    expect(t.getClosed(T0 + 40 * MIN)).toEqual([
      { id: a, name: 'A', closedAt: T0 + 30 * MIN, totalMs: 30 * MIN },
    ]);
  });

  it('resets the whole minutes and ends the session as a close', () => {
    const { db, t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    const now = T0 + 754 * MIN + 40_000; // 12h 34m 40s

    expect(t.close(now, a)).toEqual({ reset: { hours: 12, minutes: 34 } });

    expect(rows(db, 'SELECT project_id, reset_at, minutes FROM resets')).toEqual([
      { project_id: a, reset_at: now, minutes: 754 },
    ]);
    expect(sessions(db)[0]).toMatchObject({ ended_at: now, end_reason: 'close' });
    expect(t.getClosed(now + 60 * MIN)).toEqual([
      { id: a, name: 'A', closedAt: now, totalMs: now - T0 },
    ]);
  });

  it('resets a project that is not running, and leaves the running one alone', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    const b = t.addProject(T0, 'B').id;
    t.start(T0, a);
    t.start(T0 + 10 * MIN, b);

    expect(t.close(T0 + 20 * MIN, a)).toEqual({ reset: { hours: 0, minutes: 10 } });
    expect(t.getState(T0 + 20 * MIN).running?.projectId).toBe(b);
  });

  it('resets nothing under a minute, and still closes', () => {
    const { db, t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    const now = T0 + 40_000;

    expect(t.close(now, a)).toEqual({ reset: null });

    expect(rows(db, 'SELECT * FROM resets')).toEqual([]);
    expect(sessions(db)[0]).toMatchObject({ ended_at: now, end_reason: 'close' });
    expect(t.getHistory(a).entries).toEqual([]);
    expect(t.getState(now).projects).toEqual([]);
    expect(t.getClosed(now)).toEqual([{ id: a, name: 'A', closedAt: now, totalMs: 40_000 }]);
  });

  it('closes a project with no time at all, resetting nothing', () => {
    const { db, t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    expect(t.close(T0 + MIN, a)).toEqual({ reset: null });
    expect(rows(db, 'SELECT * FROM resets')).toEqual([]);
  });

  it('shows the reset in the history, and reopening keeps it', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    const now = T0 + 754 * MIN + 40_000;
    t.close(now, a);

    expect(t.getHistory(a).entries).toEqual([{ kind: 'reset', id: 1, at: now, minutes: 754 }]);

    t.reopen(now + 5 * MIN, a);

    expect(t.getHistory(a).entries).toEqual([{ kind: 'reset', id: 1, at: now, minutes: 754 }]);
    // Current stays at the leftover seconds, and the timer does not restart by itself.
    expect(project(t, now + 5 * MIN, a)).toMatchObject({ currentMs: 40_000, totalMs: now - T0 });
    expect(t.getState(now + 5 * MIN).running).toBeNull();
  });

  it('leaves another running project alone', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    const b = t.addProject(T0, 'B').id;
    t.start(T0, a);
    t.close(T0 + 10 * MIN, b);
    expect(t.getState(T0 + 10 * MIN).running?.projectId).toBe(a);
  });

  it('lists the most recently closed first', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    const b = t.addProject(T0, 'B').id;
    const c = t.addProject(T0, 'C').id;
    t.close(T0 + MIN, a);
    t.close(T0 + 2 * MIN, b);
    t.close(T0 + 2 * MIN, c);
    expect(t.getClosed(T0 + 3 * MIN).map((p) => p.name)).toEqual(['C', 'B', 'A']);
  });

  it('refuses to close a closed or missing project', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.close(T0, a);
    expectTrackerError(() => t.close(T0, a), 'not_active');
    expectTrackerError(() => t.close(T0, 999), 'not_found');
  });

  it('reopens with the same totals and history, in its original place', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.addProject(T0, 'B');
    t.start(T0, a);
    t.reset(T0 + 60 * MIN, a);
    t.adjust(T0 + 61 * MIN, a, 15, 'extra');
    const before = project(t, T0 + 62 * MIN, a);
    const historyBefore = t.getHistory(a);

    // Closing resets the 15 minutes the adjustment left in Current (R5.1).
    t.close(T0 + 62 * MIN, a);
    t.reopen(T0 + 90 * MIN, a);

    expect(project(t, T0 + 90 * MIN, a)).toEqual({ ...before, currentMs: 0 });
    expect(t.getHistory(a)).toEqual({
      ...historyBefore,
      entries: [{ kind: 'reset', id: 2, at: T0 + 62 * MIN, minutes: 15 }, ...historyBefore.entries],
    });
    expect(names(t, T0 + 90 * MIN)).toEqual(['A', 'B']);
    expect(t.getClosed(T0 + 90 * MIN)).toEqual([]);
    t.start(T0 + 91 * MIN, a);
    expect(t.getState(T0 + 91 * MIN).running?.projectId).toBe(a);
  });

  it('refuses to reopen an active or missing project', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    expect(expectTrackerError(() => t.reopen(T0, a), 'not_closed').message).toBe(
      'A is already active.',
    );
    expectTrackerError(() => t.reopen(T0, 999), 'not_found');
  });
});

describe('paused state', () => {
  it('has no last project once that project is closed', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.pause(T0 + 10 * MIN);
    expect(t.getState(T0 + 11 * MIN).paused).toEqual({
      since: T0 + 10 * MIN,
      reason: 'break',
      lastProjectId: a,
    });

    t.close(T0 + 20 * MIN, a);
    expect(t.getState(T0 + 21 * MIN).paused).toEqual({
      since: T0 + 10 * MIN,
      reason: 'break',
      lastProjectId: null,
    });
  });

  it('reports the reason a closing project was stopped with', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.close(T0 + 10 * MIN, a);
    expect(t.getState(T0 + 11 * MIN).paused).toEqual({
      since: T0 + 10 * MIN,
      reason: 'close',
      lastProjectId: null,
    });
  });
});

describe('automatic pauses waiting for a choice', () => {
  function twoPending() {
    const { db, t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    const b = t.addProject(T0, 'B').id;
    t.start(T0, a);
    fakeAutoPause(db, 1, 'locked', T0 + 30 * MIN);
    t.start(T0 + 40 * MIN, b);
    fakeAutoPause(db, 2, 'idle', T0 + 50 * MIN, T0 + 55 * MIN);
    return { db, t, a, b };
  }

  it('are listed in getState with when they paused and whether the user is back', () => {
    const { t, a, b } = twoPending();
    const state = t.getState(T0 + 60 * MIN);
    expect(state.awayNotices).toEqual([
      {
        sessionId: 1,
        projectId: a,
        projectName: 'A',
        reason: 'locked',
        pausedAt: T0 + 30 * MIN,
        returnedAt: null,
        nextStartedAt: T0 + 40 * MIN,
      },
      {
        sessionId: 2,
        projectId: b,
        projectName: 'B',
        reason: 'idle',
        pausedAt: T0 + 50 * MIN,
        returnedAt: T0 + 55 * MIN,
        nextStartedAt: null,
      },
    ]);
    expect(state.paused).toEqual({ since: T0 + 50 * MIN, reason: 'idle', lastProjectId: b });
  });

  it('are not listed once resolved', () => {
    const { db, t } = twoPending();
    db.prepare(
      "UPDATE auto_pauses SET resolution = 'dismissed', resolved_at = ? WHERE session_id = 1",
    ).run(T0 + 60 * MIN);
    expect(t.getState(T0 + 60 * MIN).awayNotices.map((n) => n.sessionId)).toEqual([2]);
  });

  it('are withdrawn by a reset of their project, and only that project', () => {
    const { db, t, a } = twoPending();
    t.reset(T0 + 60 * MIN, a);
    expect(autoPauseRow(db, 1)).toEqual({ resolution: 'withdrawn', resolved_at: T0 + 60 * MIN });
    expect(autoPauseRow(db, 2)).toEqual({ resolution: null, resolved_at: null });
    expect(t.getState(T0 + 60 * MIN).awayNotices.map((n) => n.sessionId)).toEqual([2]);
  });

  it('are withdrawn by closing their project, and only that project', () => {
    const { db, t, a } = twoPending();
    t.close(T0 + 60 * MIN, a);
    expect(autoPauseRow(db, 1)).toEqual({ resolution: 'withdrawn', resolved_at: T0 + 60 * MIN });
    expect(autoPauseRow(db, 2)).toEqual({ resolution: null, resolved_at: null });
    expect(t.getState(T0 + 60 * MIN).awayNotices.map((n) => n.sessionId)).toEqual([2]);
  });

  it('stay pending when a reset fails', () => {
    const { db, t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    fakeAutoPause(db, 1, 'locked', T0 + 30_000);
    expectTrackerError(() => t.reset(T0 + 5 * MIN, a), 'too_little_time');
    expect(autoPauseRow(db, 1)).toEqual({ resolution: null, resolved_at: null });
  });
});

describe('what a start or pause leaves for backdating', () => {
  it('writes last_action for start, switch and pause', () => {
    const { db, t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    const b = t.addProject(T0, 'B').id;
    expect(lastActionMeta(db)).toBeUndefined();

    t.start(T0, a);
    expect(lastActionMeta(db)).toEqual({
      kind: 'start',
      at: T0,
      newSessionId: 1,
      prevSessionId: null,
    });

    t.start(T0 + 15 * MIN, b);
    expect(lastActionMeta(db)).toEqual({
      kind: 'switch',
      at: T0 + 15 * MIN,
      newSessionId: 2,
      prevSessionId: 1,
    });

    t.pause(T0 + 20 * MIN);
    expect(lastActionMeta(db)).toEqual({
      kind: 'pause',
      at: T0 + 20 * MIN,
      newSessionId: null,
      prevSessionId: 2,
    });
  });

  it('keeps it when a start or pause does nothing', () => {
    const { db, t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.pause(T0);
    expect(lastActionMeta(db)).toBeUndefined();

    t.start(T0 + MIN, a);
    t.start(T0 + 2 * MIN, a);
    expect(lastActionMeta(db)).toMatchObject({ kind: 'start', at: T0 + MIN });

    t.pause(T0 + 3 * MIN);
    t.pause(T0 + 4 * MIN);
    expect(lastActionMeta(db)).toMatchObject({ kind: 'pause', at: T0 + 3 * MIN });
  });

  it('is not touched by adding a project or changing settings', () => {
    const { db, t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.addProject(T0 + MIN, 'B');
    t.setSettings({ checkinMinutes: 5, volume: 0.5 });
    expect(lastActionMeta(db)).toMatchObject({ kind: 'start', at: T0 });
  });

  it.each([
    ['reset', (t: Tracker, a: number) => t.reset(T0 + 5 * MIN, a)],
    ['adjust', (t: Tracker, a: number) => t.adjust(T0 + 5 * MIN, a, 5, 'why')],
    ['close', (t: Tracker, a: number) => t.close(T0 + 5 * MIN, a)],
  ])('is cleared by %s', (_label, act) => {
    const { db, t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    t.pause(T0 + 3 * MIN);
    expect(lastActionMeta(db)).toBeDefined();
    act(t, a);
    expect(lastActionMeta(db)).toBeUndefined();
  });

  it('is cleared by reopen', () => {
    const { db, t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    const b = t.addProject(T0, 'B').id;
    t.close(T0, b);
    t.start(T0 + MIN, a);
    expect(lastActionMeta(db)).toBeDefined();
    t.reopen(T0 + 2 * MIN, b);
    expect(lastActionMeta(db)).toBeUndefined();
  });

  it('shows up in getState, and not before there is one', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    expect(t.getState(T0).lastAction).toBeNull();
    t.start(T0, a);
    expect(t.getState(T0).lastAction).toEqual({
      kind: 'start',
      at: T0,
      earliest: T0 - 12 * 60 * MIN,
    });
  });
});

describe('settings', () => {
  it('has defaults', () => {
    const { t } = makeTracker();
    expect(t.getSettings()).toEqual({ checkinMinutes: 10, volume: 0.6 });
    expect(t.getSettings()).toEqual(DEFAULT_SETTINGS);
    expect(t.getState(T0).settings).toEqual(DEFAULT_SETTINGS);
  });

  it.each(CHECKIN_OPTIONS)('accepts a check-in of %i minutes', (minutes) => {
    const { t } = makeTracker();
    expect(t.setSettings({ checkinMinutes: minutes })).toEqual({
      checkinMinutes: minutes,
      volume: 0.6,
    });
  });

  it('rejects a check-in that is not an option', () => {
    const { t } = makeTracker();
    expectTrackerError(() => t.setSettings({ checkinMinutes: 7 }), 'invalid_input');
    expectTrackerError(() => t.setSettings({ checkinMinutes: '10' }), 'invalid_input');
    expect(t.getSettings().checkinMinutes).toBe(10);
  });

  it('accepts volumes from the minimum up to 1', () => {
    const { t } = makeTracker();
    expect(t.setSettings({ volume: MIN_VOLUME }).volume).toBe(MIN_VOLUME);
    expect(t.setSettings({ volume: 1 }).volume).toBe(1);
    expect(t.setSettings({ volume: 0.35 }).volume).toBe(0.35);
  });

  it.each([
    ['below the minimum', MIN_VOLUME - 0.01],
    ['above 1', 1.01],
    ['NaN', NaN],
    ['infinite', Infinity],
    ['a string', '0.5'],
  ])('rejects a volume that is %s', (_label, volume) => {
    const { t } = makeTracker();
    expectTrackerError(() => t.setSettings({ volume }), 'invalid_input');
    expect(t.getSettings().volume).toBe(0.6);
  });

  it('rejects unknown keys and non-objects', () => {
    const { t } = makeTracker();
    expectTrackerError(() => t.setSettings({ colour: 'red' }), 'invalid_input');
    expectTrackerError(() => t.setSettings({ volume: 0.5, colour: 'red' }), 'invalid_input');
    expectTrackerError(() => t.setSettings(null), 'invalid_input');
    expectTrackerError(() => t.setSettings([]), 'invalid_input');
    expect(t.getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('saves nothing when one of the values is invalid', () => {
    const { t } = makeTracker();
    expectTrackerError(() => t.setSettings({ checkinMinutes: 15, volume: 5 }), 'invalid_input');
    expect(t.getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps the settings that were not mentioned', () => {
    const { t } = makeTracker();
    t.setSettings({ checkinMinutes: 15 });
    t.setSettings({ volume: 0.4 });
    expect(t.getSettings()).toEqual({ checkinMinutes: 15, volume: 0.4 });
  });

  it('persists across a new Tracker on the same database', () => {
    const { db, t } = makeTracker();
    t.setSettings({ checkinMinutes: 15, volume: 0.4 });
    expect(new Tracker(db).getSettings()).toEqual({ checkinMinutes: 15, volume: 0.4 });
  });
});

describe('export', () => {
  it('JSON has every table and the settings', () => {
    const { db, t } = makeTracker();
    const a = t.addProject(T0, 'A').id;
    t.start(T0, a);
    fakeAutoPause(db, 1, 'locked', T0 + 30 * MIN);
    t.adjust(T0 + 40 * MIN, a, 5, 'extra');
    t.reset(T0 + 41 * MIN, a);
    t.setSettings({ checkinMinutes: 5 });

    const data = t.exportJson(T0 + 50 * MIN);

    expect(Object.keys(data).sort()).toEqual(
      [
        'adjustments',
        'app',
        'autoPauses',
        'exportedAt',
        'projects',
        'resets',
        'schemaVersion',
        'sessions',
        'settings',
      ].sort(),
    );
    expect(data).toMatchObject({
      app: 'work-hours',
      exportedAt: T0 + 50 * MIN,
      schemaVersion: 1,
      settings: { checkinMinutes: 5, volume: 0.6 },
    });
    expect(data.projects).toMatchObject([{ id: a, name: 'A', status: 'active' }]);
    expect(data.sessions).toMatchObject([{ id: 1, project_id: a, end_reason: 'locked' }]);
    expect(data.resets).toMatchObject([{ project_id: a, minutes: 35 }]);
    expect(data.adjustments).toMatchObject([{ project_id: a, minutes: 5, reason: 'extra' }]);
    expect(data.autoPauses).toMatchObject([{ session_id: 1, resolution: 'withdrawn' }]);
    // It must be plain data.
    expect(() => JSON.stringify(data)).not.toThrow();
  });

  it('CSV has a header and one row per reset, oldest first', () => {
    const { t } = makeTracker();
    const a = t.addProject(T0, 'Acme').id;
    const b = t.addProject(T0, 'Beta').id;
    t.start(T0, a);
    t.reset(T0 + 65 * MIN, a); // 1h 05m
    t.adjust(T0 + 66 * MIN, b, 120, 'seed');
    t.reset(T0 + 70 * MIN, b); // 2h 00m
    t.adjust(T0 + 71 * MIN, a, 30, 'more');
    t.reset(T0 + 72 * MIN, a); // 0h 30m

    const lines = t.exportCsv().split('\n');
    expect(lines[0]).toBe('project,date,hours,minutes');
    expect(lines).toHaveLength(5); // header, three rows, and the trailing newline
    expect(lines[4]).toBe('');
    const parsed = lines.slice(1, 4).map(parseCsvRow);
    expect(parsed.map((r) => [r.name, r.hours, r.minutes])).toEqual([
      ['Acme', '1', '5'],
      ['Beta', '2', '0'],
      ['Acme', '0', '30'],
    ]);
    // The date is the reset time in local time, to the minute.
    expect(parsed.map((r) => r.localMs)).toEqual([T0 + 65 * MIN, T0 + 70 * MIN, T0 + 72 * MIN]);
  });

  it('CSV has only the header when nothing was reset', () => {
    const { t } = makeTracker();
    t.addProject(T0, 'A');
    expect(t.exportCsv()).toBe('project,date,hours,minutes\n');
  });

  it('CSV quotes names with commas or quotes', () => {
    const { t } = makeTracker();
    bill(t, T0, t.addProject(T0, 'Acme, Inc').id, 10);
    bill(t, T0 + MIN, t.addProject(T0, 'He said "hi"').id, 10);
    const [, first, second] = t.exportCsv().split('\n');
    expect(first).toMatch(/^"Acme, Inc",/);
    expect(second).toMatch(/^"He said ""hi""",/);
  });

  it.each(['=', '+', '-', '@'])('CSV defuses a name starting with %s', (lead) => {
    const { t } = makeTracker();
    bill(t, T0, t.addProject(T0, `${lead}cmd`).id, 10);
    const [, row] = t.exportCsv().split('\n');
    expect(row).toMatch(new RegExp(`^'${escapeRegExp(lead)}cmd,`));
  });

  it('CSV defuses and quotes a name that needs both', () => {
    const { t } = makeTracker();
    bill(t, T0, t.addProject(T0, '=SUM(1,2)').id, 10);
    const [, row] = t.exportCsv().split('\n');
    expect(row).toMatch(/^"'=SUM\(1,2\)",/);
  });
});

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Splits `name,YYYY-MM-DD HH:MM,hours,minutes` (the name may be quoted) and reads the date back. */
function parseCsvRow(line: string) {
  const match = /^(.*),(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}),(\d+),(\d+)$/.exec(line);
  if (!match) throw new Error(`Not a CSV row: ${line}`);
  const [, name, y, mo, d, h, mi, hours, minutes] = match.map(String);
  return {
    name,
    hours,
    minutes,
    localMs: new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)).getTime(),
  };
}
