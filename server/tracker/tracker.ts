import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { transaction } from '../db/index.js';
import {
  APP_ID,
  AUTO_REASONS,
  CHECKIN_OPTIONS,
  DEFAULT_SETTINGS,
  MIN_VOLUME,
  type AppState,
  type AutoReason,
  type AwayNotice,
  type CheckinMinutes,
  type ClosedProject,
  type CloseResult,
  type EndReason,
  type HistoryEntry,
  type ProjectHistory,
  type ProjectSummary,
  type ResetResult,
  type Settings,
} from '../../shared/types.js';
import { TrackerError } from './errors.js';
import { normalizeName, normalizeReason } from './names.js';
import { MS_PER_MINUTE, formatLocalDateTime, splitMinutes } from './time.js';

/** Largest adjustment, in minutes either way (R4.1). */
const MAX_ADJUST_MINUTES = 100_000;

/** How far before the click a first-ever Start can be backdated (DESIGN §5). */
const MAX_START_BACKDATE_MS = 12 * 60 * MS_PER_MINUTE;

const LAST_ACTION_KEY = 'last_action';
const LAST_ALIVE_KEY = 'last_alive_at';
const CHECKIN_KEY = 'checkin_minutes';
const VOLUME_KEY = 'volume';

/** What app_meta.last_action holds (DESIGN §5). */
interface StoredLastAction {
  kind: 'start' | 'switch' | 'pause';
  at: number;
  newSessionId: number | null;
  prevSessionId: number | null;
}
/** A stored last action that still matches the sessions, with the earliest time it can move to. */
interface ValidLastAction extends StoredLastAction {
  earliest: number;
}

// Rows as SQLite returns them.
interface ProjectRow {
  id: number;
  name: string;
  status: 'active' | 'closed';
  created_at: number;
  closed_at: number | null;
}
interface SessionRow {
  id: number;
  project_id: number;
  started_at: number;
  ended_at: number | null;
  end_reason: EndReason | null;
}
interface TotalsRow extends ProjectRow {
  total_ms: number;
  billed_ms: number;
}

/**
 * The derived values of DESIGN §4 as SQL, the one place they are defined. `?1` is `now`
 * (a running session counts up to it). Used for one project and for lists of projects.
 */
const TOTALS_COLUMNS = `
  p.id, p.name, p.status, p.created_at, p.closed_at,
  COALESCE((SELECT SUM(COALESCE(s.ended_at, ?1) - s.started_at)
            FROM sessions s WHERE s.project_id = p.id), 0)
    + ${MS_PER_MINUTE} * COALESCE((SELECT SUM(a.minutes)
                                   FROM adjustments a WHERE a.project_id = p.id), 0) AS total_ms,
  ${MS_PER_MINUTE} * COALESCE((SELECT SUM(r.minutes)
                               FROM resets r WHERE r.project_id = p.id), 0) AS billed_ms`;

/** The automatic reasons as a SQL list, for `end_reason IN (...)`. */
const AUTO_REASONS_SQL = AUTO_REASONS.map((reason) => `'${reason}'`).join(', ');

export class Tracker {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  // ---- Projects (R1, R5) ----

  addProject(now: number, rawName: unknown): { id: number } {
    const name = normalizeName(rawName);
    return transaction(this.db, () => {
      this.rejectDuplicateName(name);
      try {
        const result = this.db
          .prepare("INSERT INTO projects (name, status, created_at) VALUES (?, 'active', ?)")
          .run(name, now);
        return { id: Number(result.lastInsertRowid) };
      } catch (err) {
        // The unique index is the safety net for what the lowercase check above missed.
        if (isUniqueViolation(err)) {
          throw new TrackerError('name_taken', `${name} already exists.`);
        }
        throw err;
      }
    });
  }

  close(now: number, projectId: number): CloseResult {
    return transaction(this.db, () => {
      const project = this.requireActive(projectId);
      this.endRunningSessionOf(project.id, now, 'close');
      // R5.1: closing resets the whole minutes left. Under a minute there is nothing to reset.
      const minutes = this.resetWholeMinutes(project.id, now);
      this.db
        .prepare("UPDATE projects SET status = 'closed', closed_at = ? WHERE id = ?")
        .run(now, project.id);
      this.withdrawPendingAutoPauses(project.id, now);
      this.clearLastAction();
      return { reset: minutes >= 1 ? splitMinutes(minutes) : null };
    });
  }

  reopen(_now: number, projectId: number): void {
    transaction(this.db, () => {
      const project = this.requireProject(projectId);
      if (project.status !== 'closed') {
        throw new TrackerError('not_closed', `${project.name} is already active.`);
      }
      this.db
        .prepare("UPDATE projects SET status = 'active', closed_at = NULL WHERE id = ?")
        .run(project.id);
      this.clearLastAction();
    });
  }

  // ---- The timer (R2) ----

  start(now: number, projectId: number): void {
    transaction(this.db, () => {
      const project = this.requireActive(projectId);
      // Starting the project is the user's "Resume" choice (R6.3). Leaving the notice pending made
      // the page offer Resume for a project that was already running.
      this.resolvePendingAutoPauses(project.id, 'resumed', now);
      const running = this.runningSession();
      if (running?.project_id === project.id) return;
      if (running) {
        this.endSession(running.id, now, 'switch');
      }
      const newSessionId = this.insertSession(project.id, now);
      this.setLastAction({
        kind: running ? 'switch' : 'start',
        at: now,
        newSessionId,
        prevSessionId: running?.id ?? null,
      });
    });
  }

  pause(now: number): void {
    transaction(this.db, () => {
      const running = this.runningSession();
      if (!running) return;
      this.endSession(running.id, now, 'break');
      this.setLastAction({ kind: 'pause', at: now, newSessionId: null, prevSessionId: running.id });
    });
  }

  /**
   * Moves the latest Start, switch or Pause back to `at` (R2.5). The last action keeps its
   * click time, so the user can backdate again anywhere in the same range.
   */
  backdate(now: number, at: number): void {
    const available = transaction(this.db, () => {
      const last = this.currentLastAction(now);
      if (!last) {
        // Forget a stale action for good. The error is thrown after the commit, or it would
        // roll this back.
        this.clearLastAction();
        return false;
      }
      if (!Number.isSafeInteger(at)) {
        throw new TrackerError('invalid_input', 'Enter a valid time.');
      }
      if (at < last.earliest || at > last.at || at > now) {
        throw new TrackerError('backdate_out_of_range', 'That time is out of range.');
      }
      const { prevSessionId, newSessionId } = last;
      // A switch moves both sides of the boundary, a pause only the end, a start only the start.
      if (last.kind !== 'start' && prevSessionId !== null) {
        this.db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(at, prevSessionId);
      }
      if (last.kind !== 'pause' && newSessionId !== null) {
        this.db.prepare('UPDATE sessions SET started_at = ? WHERE id = ?').run(at, newSessionId);
      }
      return true;
    });
    if (!available) {
      throw new TrackerError('backdate_unavailable', "There's nothing to move back.");
    }
  }

  // ---- Reset and adjust (R3, R4) ----

  reset(now: number, projectId: number): ResetResult {
    return transaction(this.db, () => {
      const project = this.requireActive(projectId);
      this.endRunningSessionOf(project.id, now, 'reset');
      const minutes = this.resetWholeMinutes(project.id, now);
      if (minutes < 1) {
        // Rolls back the end of the session above, so a running timer keeps running.
        throw new TrackerError('too_little_time', 'Reset needs at least 1 minute.');
      }
      this.withdrawPendingAutoPauses(project.id, now);
      this.clearLastAction();
      return splitMinutes(minutes);
    });
  }

  adjust(now: number, projectId: number, minutes: unknown, reason: unknown): void {
    transaction(this.db, () => {
      const project = this.requireActive(projectId);
      const delta = validateAdjustMinutes(minutes);
      const cleanReason = normalizeReason(reason);
      // R4.3: Current can't go below zero, and time already reset has been billed.
      if (this.totals(project.id, now).currentMs + delta * MS_PER_MINUTE < 0) {
        throw new TrackerError(
          'would_go_negative',
          `That would take ${project.name} below zero. Time already reset has been billed.`,
        );
      }
      this.db
        .prepare(
          'INSERT INTO adjustments (project_id, created_at, minutes, reason) VALUES (?, ?, ?, ?)',
        )
        .run(project.id, now, delta, cleanReason);
      this.clearLastAction();
    });
  }

  // ---- Away and recovery (R6, DESIGN §6) ----

  /**
   * Ends the running session as of `at` (kept between its start and `now`) and records the
   * pause for the user to resolve. Returns null, changing nothing, if nothing is running.
   */
  autoPause(now: number, reason: AutoReason, at: number): AwayNotice | null {
    return transaction(this.db, () => {
      const running = this.runningSession();
      if (!running) return null;
      // Not after now, and never before the start (even if the clock moved backwards).
      const endedAt = Math.max(Math.min(at, now), running.started_at);
      this.endSession(running.id, endedAt, reason);
      // A session that "Count it" reopened can be paused again, so its old row is replaced.
      this.db
        .prepare(
          `INSERT INTO auto_pauses (session_id, detected_at) VALUES (?, ?)
           ON CONFLICT (session_id) DO UPDATE SET detected_at = excluded.detected_at,
             returned_at = NULL, resolution = NULL, resolved_at = NULL`,
        )
        .run(running.id, now);
      this.clearLastAction();
      return {
        sessionId: running.id,
        projectId: running.project_id,
        projectName: this.requireProject(running.project_id).name,
        reason,
        pausedAt: endedAt,
        returnedAt: null,
        // The running session is always the newest one, so nothing has started after it.
        nextStartedAt: null,
      };
    });
  }

  /** The user is back: stamps every pending, not yet returned pause. Returns their session ids. */
  markReturned(now: number, at: number): number[] {
    return transaction(this.db, () =>
      this.all<{ session_id: number }>(
        `UPDATE auto_pauses SET returned_at = ?
          WHERE resolution IS NULL AND returned_at IS NULL
          RETURNING session_id`,
        Math.min(at, now),
      )
        .map((row) => row.session_id)
        .sort((a, b) => a - b),
    );
  }

  /** "Count it": the time away belongs to the project (R6.3). */
  countAway(now: number, sessionId: number): void {
    transaction(this.db, () => {
      this.requirePendingAway(sessionId);
      const next = this.get<{ started_at: number | null }>(
        'SELECT MIN(started_at) AS started_at FROM sessions WHERE id > ?',
        sessionId,
      )?.started_at;
      if (next === null || next === undefined) {
        // Nothing has started since, so the timer carries on as if it never paused.
        if (this.runningSession()) {
          throw new Error(`Session ${sessionId} has no successor but another is running`);
        }
        this.db
          .prepare('UPDATE sessions SET ended_at = NULL, end_reason = NULL WHERE id = ?')
          .run(sessionId);
      } else {
        this.db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(next, sessionId);
      }
      this.resolveAway(sessionId, 'counted', now);
      this.clearLastAction();
    });
  }

  /** "Resume": the time away is not counted; the project starts again now. */
  resumeAfterAway(now: number, sessionId: number): void {
    transaction(this.db, () => {
      const { projectId } = this.requirePendingAway(sessionId);
      this.resolveAway(sessionId, 'resumed', now);
      this.clearLastAction();
      // After the clear, so the fresh last action from start() survives.
      this.start(now, projectId);
    });
  }

  /** "Dismiss": the time away is not counted and nothing starts. */
  dismissAway(now: number, sessionId: number): void {
    transaction(this.db, () => {
      this.requirePendingAway(sessionId);
      this.resolveAway(sessionId, 'dismissed', now);
      this.clearLastAction();
    });
  }

  /** At startup: a session still open means the server died, so pause it as of the last sign of life. */
  recoverFromCrash(now: number): AwayNotice | null {
    return transaction(this.db, () => {
      const running = this.runningSession();
      if (!running) return null;
      const alive = this.getMeta(LAST_ALIVE_KEY);
      const at = alive === undefined ? NaN : Number(alive);
      return this.autoPause(now, 'stopped', Number.isFinite(at) ? at : running.started_at);
    });
  }

  /** The server's heartbeat, read back by recoverFromCrash. */
  touchAlive(now: number): void {
    transaction(this.db, () => {
      this.setMeta(LAST_ALIVE_KEY, String(now));
    });
  }

  // ---- Reading ----

  getState(now: number): AppState {
    const running = this.runningSession();
    const last = this.currentLastAction(now);
    return {
      now,
      running: running
        ? { projectId: running.project_id, sessionId: running.id, startedAt: running.started_at }
        : null,
      paused: running ? null : this.pausedState(),
      projects: this.activeProjects(now),
      awayNotices: this.pendingAwayNotices(),
      lastAction: last ? { kind: last.kind, at: last.at, earliest: last.earliest } : null,
      settings: this.getSettings(),
    };
  }

  getClosed(now: number): ClosedProject[] {
    const rows = this.all<TotalsRow>(
      `SELECT ${TOTALS_COLUMNS} FROM projects p
       WHERE p.status = 'closed' ORDER BY p.closed_at DESC, p.id DESC`,
      now,
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      // Closed projects always have closed_at (set together in close()).
      closedAt: row.closed_at ?? 0,
      totalMs: derive(row).totalMs,
    }));
  }

  /** Resets and adjustments of one project, newest first (R3.5, R4.2). */
  getHistory(projectId: number): ProjectHistory {
    const project = this.requireProject(projectId);
    const rows = this.all<{
      kind: 'reset' | 'adjustment';
      id: number;
      at: number;
      minutes: number;
      reason: string | null;
    }>(
      `SELECT 'reset' AS kind, id, reset_at AS at, minutes, NULL AS reason
         FROM resets WHERE project_id = ?1
       UNION ALL
       SELECT 'adjustment', id, created_at, minutes, reason
         FROM adjustments WHERE project_id = ?1
       ORDER BY at DESC, id DESC, kind DESC`,
      project.id,
    );
    const entries = rows.map((row): HistoryEntry => {
      const { id, at, minutes } = row;
      return row.kind === 'reset'
        ? { kind: 'reset', id, at, minutes }
        : { kind: 'adjustment', id, at, minutes, reason: row.reason ?? '' };
    });
    return { projectId: project.id, name: project.name, entries };
  }

  // ---- Settings (R8.4) ----

  getSettings(): Settings {
    const checkinMinutes = Number(this.getMeta(CHECKIN_KEY));
    const volume = Number(this.getMeta(VOLUME_KEY));
    return {
      checkinMinutes: isCheckinMinutes(checkinMinutes)
        ? checkinMinutes
        : DEFAULT_SETTINGS.checkinMinutes,
      volume: isVolume(volume) ? volume : DEFAULT_SETTINGS.volume,
    };
  }

  /** Changes the given settings and keeps the rest. Nothing is saved if any value is invalid. */
  setSettings(partial: unknown): Settings {
    const changes = parseSettingsChanges(partial);
    return transaction(this.db, () => {
      if (changes.checkinMinutes !== undefined) {
        this.setMeta(CHECKIN_KEY, String(changes.checkinMinutes));
      }
      if (changes.volume !== undefined) {
        this.setMeta(VOLUME_KEY, String(changes.volume));
      }
      return this.getSettings();
    });
  }

  // ---- Export (R9.3) ----

  exportJson(now: number): Record<string, unknown> {
    return {
      app: APP_ID,
      exportedAt: now,
      schemaVersion: Number(this.db.prepare('PRAGMA user_version').get()?.user_version),
      projects: this.all('SELECT * FROM projects ORDER BY id'),
      sessions: this.all('SELECT * FROM sessions ORDER BY id'),
      resets: this.all('SELECT * FROM resets ORDER BY id'),
      adjustments: this.all('SELECT * FROM adjustments ORDER BY id'),
      autoPauses: this.all('SELECT * FROM auto_pauses ORDER BY session_id'),
      settings: this.getSettings(),
    };
  }

  /** One row per reset, the way the user enters it in the client's billing system. */
  exportCsv(): string {
    const rows = this.all<{ name: string; reset_at: number; minutes: number }>(
      `SELECT p.name, r.reset_at, r.minutes
         FROM resets r JOIN projects p ON p.id = r.project_id
        ORDER BY r.reset_at, r.id`,
    );
    const lines = rows.map((row) => {
      const { hours, minutes } = splitMinutes(row.minutes);
      return [csvCell(row.name), formatLocalDateTime(row.reset_at), hours, minutes].join(',');
    });
    return ['project,date,hours,minutes', ...lines].join('\n') + '\n';
  }

  // ---- Private: lookups ----

  private requireProject(projectId: number): ProjectRow {
    const project = this.get<ProjectRow>(
      'SELECT id, name, status, created_at, closed_at FROM projects WHERE id = ?',
      projectId,
    );
    if (!project) {
      throw new TrackerError('not_found', "That project doesn't exist.");
    }
    return project;
  }

  private requireActive(projectId: number): ProjectRow {
    const project = this.requireProject(projectId);
    if (project.status !== 'active') {
      throw new TrackerError('not_active', `${project.name} is closed. Reopen it first.`);
    }
    return project;
  }

  /** R1.2: names are unique across active and closed projects, in any letter case. */
  private rejectDuplicateName(name: string): void {
    const wanted = name.toLocaleLowerCase();
    const existing = this.all<Pick<ProjectRow, 'id' | 'name' | 'status'>>(
      'SELECT id, name, status FROM projects',
    ).find((p) => p.name.toLocaleLowerCase() === wanted);
    if (!existing) return;
    if (existing.status === 'active') {
      throw new TrackerError('name_taken', `${existing.name} already exists.`);
    }
    throw new TrackerError('name_taken_closed', `A closed project is called ${existing.name}.`, {
      projectId: existing.id,
    });
  }

  private runningSession(): SessionRow | undefined {
    return this.get<SessionRow>(
      'SELECT id, project_id, started_at, ended_at, end_reason FROM sessions WHERE ended_at IS NULL',
    );
  }

  private sessionById(sessionId: number | null): SessionRow | undefined {
    if (sessionId === null) return undefined;
    return this.get<SessionRow>(
      'SELECT id, project_id, started_at, ended_at, end_reason FROM sessions WHERE id = ?',
      sessionId,
    );
  }

  /** The pending away notice of a session (not yet counted, resumed, dismissed or withdrawn). */
  private requirePendingAway(sessionId: number): { projectId: number } {
    const row = this.get<{ project_id: number }>(
      `SELECT s.project_id FROM auto_pauses a JOIN sessions s ON s.id = a.session_id
        WHERE a.session_id = ? AND a.resolution IS NULL`,
      sessionId,
    );
    if (!row) {
      throw new TrackerError('not_pending', 'That notice has already been handled.');
    }
    return { projectId: row.project_id };
  }

  /**
   * The stored last action if the sessions still look the way it left them, with the earliest
   * time it can be backdated to; otherwise null. Shared by backdate and getState, so what the
   * UI offers is what backdate accepts. Reads only.
   */
  private currentLastAction(now: number): ValidLastAction | null {
    const stored = parseStoredLastAction(this.getMeta(LAST_ACTION_KEY));
    if (!stored) return null;
    const created = this.sessionById(stored.newSessionId);
    const prev = this.sessionById(stored.prevSessionId);
    switch (stored.kind) {
      case 'start': {
        if (created?.ended_at !== null) return null;
        // Sessions must not overlap, so the start can't go before the last stop.
        const latestEnd = this.get<{ latest: number | null }>(
          'SELECT MAX(ended_at) AS latest FROM sessions WHERE id <> ?',
          created.id,
        )?.latest;
        return { ...stored, earliest: latestEnd ?? stored.at - MAX_START_BACKDATE_MS };
      }
      case 'switch':
        if (created?.ended_at !== null) return null;
        if (prev?.end_reason !== 'switch' || prev.ended_at === null) return null;
        return { ...stored, earliest: this.earliestEnd(prev, prev.ended_at, now) };
      case 'pause':
        if (prev?.end_reason !== 'break' || prev.ended_at === null) return null;
        if (this.runningSession()) return null;
        return { ...stored, earliest: this.earliestEnd(prev, prev.ended_at, now) };
    }
  }

  /**
   * How early an ended session may end: not before it started, and not so early that its
   * project's Current would go below zero (R4.3). Moving the end earlier by d lowers both
   * the end and Current by d, so this bound does not move when the user backdates.
   */
  private earliestEnd(session: SessionRow, endedAt: number, now: number): number {
    const { currentMs } = this.totals(session.project_id, now);
    return Math.max(session.started_at, endedAt - currentMs);
  }

  /** Totals of one project as of `now`; see TOTALS_COLUMNS. */
  private totals(projectId: number, now: number): { totalMs: number; currentMs: number } {
    const row = this.get<TotalsRow>(
      `SELECT ${TOTALS_COLUMNS} FROM projects p WHERE p.id = ?2`,
      now,
      projectId,
    );
    if (!row) {
      throw new TrackerError('not_found', "That project doesn't exist.");
    }
    return derive(row);
  }

  private activeProjects(now: number): ProjectSummary[] {
    // The latest session is the project's highest session id (ids follow creation order). The
    // CASE maps a counted automatic pause to 'switch': countAway with a later session moves
    // ended_at to where that session started but keeps the automatic end_reason, so as stored it
    // would read "screen locked" at the moment the user actually switched. The stored reason is
    // left alone so the record and the export keep it. A session that Count reopened and that
    // was auto-paused again has its resolution reset to NULL by autoPause, so it shows the new
    // automatic reason. One that Count reopened and the user then paused, reset or closed keeps
    // resolution 'counted', so the reason must be automatic too for it to read as a switch.
    const rows = this.all<
      TotalsRow & { last_ended_at: number | null; last_end_reason: EndReason | null }
    >(
      `SELECT ${TOTALS_COLUMNS},
              ls.ended_at AS last_ended_at,
              CASE WHEN ls.ended_at IS NULL THEN NULL
                   WHEN ap.resolution = 'counted'
                        AND ls.end_reason IN (${AUTO_REASONS_SQL}) THEN 'switch'
                   ELSE ls.end_reason END AS last_end_reason
         FROM projects p
         LEFT JOIN sessions ls ON ls.id = (SELECT MAX(s.id) FROM sessions s WHERE s.project_id = p.id)
         LEFT JOIN auto_pauses ap ON ap.session_id = ls.id
        WHERE p.status = 'active' ORDER BY p.created_at, p.id`,
      now,
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      ...derive(row),
      lastPause:
        row.last_ended_at === null || row.last_end_reason === null
          ? null
          : { at: row.last_ended_at, reason: row.last_end_reason },
    }));
  }

  /** The most recent ended session, shown as "Paused" while nothing is running. */
  private pausedState(): AppState['paused'] {
    const last = this.get<{
      ended_at: number;
      end_reason: EndReason;
      project_id: number;
      status: ProjectRow['status'];
    }>(
      `SELECT s.ended_at, s.end_reason, p.id AS project_id, p.status
         FROM sessions s JOIN projects p ON p.id = s.project_id
        WHERE s.ended_at IS NOT NULL
        ORDER BY s.ended_at DESC, s.id DESC LIMIT 1`,
    );
    if (!last) return null;
    return {
      since: last.ended_at,
      reason: last.end_reason,
      lastProjectId: last.status === 'active' ? last.project_id : null,
    };
  }

  private pendingAwayNotices(): AwayNotice[] {
    const rows = this.all<{
      session_id: number;
      project_id: number;
      name: string;
      end_reason: AutoReason;
      ended_at: number;
      returned_at: number | null;
      next_started_at: number | null;
    }>(
      `SELECT a.session_id, s.project_id, p.name, s.end_reason, s.ended_at, a.returned_at,
              (SELECT MIN(n.started_at) FROM sessions n WHERE n.id > a.session_id) AS next_started_at
         FROM auto_pauses a
         JOIN sessions s ON s.id = a.session_id
         JOIN projects p ON p.id = s.project_id
        WHERE a.resolution IS NULL
        ORDER BY a.session_id`,
    );
    return rows.map((row) => ({
      sessionId: row.session_id,
      projectId: row.project_id,
      projectName: row.name,
      reason: row.end_reason,
      pausedAt: row.ended_at,
      returnedAt: row.returned_at,
      nextStartedAt: row.next_started_at,
    }));
  }

  // ---- Private: writes ----

  private insertSession(projectId: number, startedAt: number): number {
    const result = this.db
      .prepare('INSERT INTO sessions (project_id, started_at) VALUES (?, ?)')
      .run(projectId, startedAt);
    return Number(result.lastInsertRowid);
  }

  private endSession(sessionId: number, endedAt: number, reason: EndReason): void {
    // MAX(): if the system clock moved backwards, end at the start rather than break the
    // ended_at >= started_at check.
    this.db
      .prepare('UPDATE sessions SET ended_at = MAX(?, started_at), end_reason = ? WHERE id = ?')
      .run(endedAt, reason, sessionId);
  }

  /** Ends the running session if it belongs to `projectId`. */
  private endRunningSessionOf(projectId: number, at: number, reason: EndReason): void {
    const running = this.runningSession();
    if (running?.project_id === projectId) {
      this.endSession(running.id, at, reason);
    }
  }

  /** Resets the whole minutes in Current as of `now` (the leftover seconds stay). Returns them. */
  private resetWholeMinutes(projectId: number, now: number): number {
    const minutes = Math.floor(this.totals(projectId, now).currentMs / MS_PER_MINUTE);
    if (minutes >= 1) {
      this.db
        .prepare('INSERT INTO resets (project_id, reset_at, minutes) VALUES (?, ?, ?)')
        .run(projectId, now, minutes);
    }
    return minutes;
  }

  private resolveAway(
    sessionId: number,
    resolution: 'counted' | 'resumed' | 'dismissed',
    now: number,
  ): void {
    this.db
      .prepare('UPDATE auto_pauses SET resolution = ?, resolved_at = ? WHERE session_id = ?')
      .run(resolution, now, sessionId);
  }

  /** Reset and close make the user's pending "you were away" choices moot (R6.4). */
  private withdrawPendingAutoPauses(projectId: number, now: number): void {
    this.resolvePendingAutoPauses(projectId, 'withdrawn', now);
  }

  /** Resolves every pending automatic pause of a project with the same resolution. */
  private resolvePendingAutoPauses(
    projectId: number,
    resolution: 'resumed' | 'withdrawn',
    now: number,
  ): void {
    this.db
      .prepare(
        `UPDATE auto_pauses SET resolution = ?, resolved_at = ?
          WHERE resolution IS NULL
            AND session_id IN (SELECT id FROM sessions WHERE project_id = ?)`,
      )
      .run(resolution, now, projectId);
  }

  // ---- Private: app_meta ----

  private getMeta(key: string): string | undefined {
    return this.get<{ value: string }>('SELECT value FROM app_meta WHERE key = ?', key)?.value;
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }

  private deleteMeta(key: string): void {
    this.db.prepare('DELETE FROM app_meta WHERE key = ?').run(key);
  }

  private setLastAction(action: StoredLastAction): void {
    this.setMeta(LAST_ACTION_KEY, JSON.stringify(action));
  }

  /** Any action that changes time other than start/pause ends the chance to backdate (§5). */
  private clearLastAction(): void {
    this.deleteMeta(LAST_ACTION_KEY);
  }

  // ---- Private: query helpers ----

  private get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  private all<T = Record<string, unknown>>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }
}

function derive(row: TotalsRow): { totalMs: number; currentMs: number } {
  return { totalMs: row.total_ms, currentMs: row.total_ms - row.billed_ms };
}

function isUniqueViolation(err: unknown): boolean {
  // SQLITE_CONSTRAINT_UNIQUE
  return err instanceof Error && (err as { errcode?: number }).errcode === 2067;
}

function isSessionIdOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value));
}

/** Reads app_meta.last_action back. Anything that isn't one is treated as no last action. */
function parseStoredLastAction(text: string | undefined): StoredLastAction | null {
  if (text === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { kind, at, newSessionId, prevSessionId } = value as Record<string, unknown>;
  if (
    (kind !== 'start' && kind !== 'switch' && kind !== 'pause') ||
    typeof at !== 'number' ||
    !Number.isSafeInteger(at) ||
    !isSessionIdOrNull(newSessionId) ||
    !isSessionIdOrNull(prevSessionId)
  ) {
    return null;
  }
  return { kind, at, newSessionId, prevSessionId };
}

function validateAdjustMinutes(minutes: unknown): number {
  if (
    typeof minutes !== 'number' ||
    !Number.isSafeInteger(minutes) ||
    minutes === 0 ||
    Math.abs(minutes) > MAX_ADJUST_MINUTES
  ) {
    throw new TrackerError('invalid_input', 'Enter a whole number of minutes other than 0.');
  }
  return minutes;
}

function isCheckinMinutes(value: unknown): value is CheckinMinutes {
  return CHECKIN_OPTIONS.some((option) => option === value);
}

function isVolume(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_VOLUME && value <= 1;
}

function parseSettingsChanges(input: unknown): Partial<Settings> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TrackerError('invalid_input', 'Settings must be an object.');
  }
  const { checkinMinutes, volume, ...unknown } = input as Record<string, unknown>;
  const unknownKey = Object.keys(unknown)[0];
  if (unknownKey !== undefined) {
    throw new TrackerError('invalid_input', `Unknown setting: ${unknownKey}.`);
  }
  const changes: Partial<Settings> = {};
  if (checkinMinutes !== undefined) {
    if (!isCheckinMinutes(checkinMinutes)) {
      throw new TrackerError(
        'invalid_input',
        `Check-in interval must be ${CHECKIN_OPTIONS.join(', ')} minutes.`,
      );
    }
    changes.checkinMinutes = checkinMinutes;
  }
  if (volume !== undefined) {
    if (!isVolume(volume)) {
      throw new TrackerError(
        'invalid_input',
        `Volume must be between ${Math.round(MIN_VOLUME * 100)}% and 100%.`,
      );
    }
    changes.volume = volume;
  }
  return changes;
}

/** One CSV field. Quotes when needed, and defuses spreadsheet formulas (a leading = + - @). */
function csvCell(text: string): string {
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /["\r\n,]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}
