import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { afterEach } from 'vitest';
import { openDatabase } from '../../server/db/index.js';
import { Tracker, TrackerError } from '../../server/tracker/index.js';
import type { ErrorCode } from '../../shared/types.js';

export const MIN = 60_000;
/** A fixed base time, so tests never read the real clock. */
export const T0 = Date.UTC(2026, 10, 23, 9, 0);

const openDatabases: DatabaseSync[] = [];

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    if (db.isOpen) db.close();
  }
});

/** A Tracker on a fresh in-memory database, closed after the test. */
export function makeTracker(): { db: DatabaseSync; t: Tracker } {
  const db = openDatabase(':memory:');
  openDatabases.push(db);
  return { db, t: new Tracker(db) };
}

/** Raw rows, for asserting on what the Tracker wrote. */
export function rows<T = Record<string, unknown>>(
  db: DatabaseSync,
  sql: string,
  ...params: SQLInputValue[]
): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export interface SessionRow {
  id: number;
  project_id: number;
  started_at: number;
  ended_at: number | null;
  end_reason: string | null;
}

export function sessions(db: DatabaseSync): SessionRow[] {
  return rows<SessionRow>(db, 'SELECT * FROM sessions ORDER BY id');
}

/** One auto_pauses row, or undefined if the session was never auto-paused. */
export function autoPauseRow(db: DatabaseSync, sessionId: number) {
  return rows<{
    detected_at: number;
    returned_at: number | null;
    resolution: string | null;
    resolved_at: number | null;
  }>(
    db,
    'SELECT detected_at, returned_at, resolution, resolved_at FROM auto_pauses WHERE session_id = ?',
    sessionId,
  )[0];
}

/** What app_meta.last_action holds, or undefined if there is none. */
export function lastActionMeta(db: DatabaseSync): unknown {
  const [row] = rows<{ value: string }>(db, "SELECT value FROM app_meta WHERE key = 'last_action'");
  return row ? JSON.parse(row.value) : undefined;
}

/** Asserts that `fn` throws a TrackerError with this code, and returns it for further checks. */
export function expectTrackerError(fn: () => unknown, code: ErrorCode): TrackerError {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  if (!(thrown instanceof TrackerError)) {
    throw new Error(`Expected a TrackerError (${code}) but got: ${String(thrown)}`);
  }
  if (thrown.code !== code) {
    throw new Error(`Expected TrackerError code ${code} but got ${thrown.code}: ${thrown.message}`);
  }
  return thrown;
}
