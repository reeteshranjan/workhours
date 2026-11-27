import { localDay } from './db/index.js';
import type { Tracker } from './tracker/index.js';
import type { EventHub } from './events.js';
import type { AppState, AwayNotice, PresenceRequest } from '../shared/types.js';

const MS_PER_HOUR = 60 * 60_000;

/** A presence report can't claim to be older than this. */
const MAX_REPORT_AGE_MS = 24 * MS_PER_HOUR;

/** A check-in this much later than due means the computer slept, so the chime would be stale. */
const CHECKIN_LATE_MS = 60_000;

type Timer = ReturnType<typeof setTimeout>;

export interface PresenceOptions {
  tracker: Tracker;
  hub: EventHub;
  /** Called on every tick, wrapped in try/catch (a failure is logged once per day, not thrown). Used for the daily backup. */
  onTick?: (now: number) => void;
  clock?: () => number;
  /** How long the connection count stays at 0 before the session is paused (R6.1). */
  graceMs?: number;
  tickMs?: number;
  /** A tick this much later than expected means the computer slept (DESIGN §6.2). */
  sleepJumpMs?: number;
  /** Must match the threshold of the page's IdleDetector (DESIGN §6.4). */
  idleThresholdMs?: number;
  log?: (msg: string) => void;
}

interface PresenceState {
  user: PresenceRequest['user'];
  screen: PresenceRequest['screen'];
}

/**
 * Owns every server-side timer: the tab-close grace period, the 15 s tick (sleep detection,
 * `last_alive_at`, the daily backup) and the check-in scheduler (DESIGN §6, §7.2). It also
 * keeps the latest presence report from the page.
 */
export class Presence {
  private readonly tracker: Tracker;
  private readonly hub: EventHub;
  private readonly onTick: ((now: number) => void) | undefined;
  private readonly clock: () => number;
  private readonly graceMs: number;
  private readonly tickMs: number;
  private readonly sleepJumpMs: number;
  private readonly idleThresholdMs: number;
  private readonly log: (msg: string) => void;

  private presence: PresenceState | null = null;
  private lastTick = 0;
  /** When the connection count last reached 0, or when a Start arrived with no tab connected. */
  private disconnectedAt = 0;
  private tickTimer: Timer | null = null;
  private graceTimer: Timer | null = null;
  private checkinTimer: Timer | null = null;
  /** Set by stop(), so a late request can't start timers again. Cleared by start(). */
  private stopped = false;
  private tickFailureDay: string | null = null;

  constructor(opts: PresenceOptions) {
    this.tracker = opts.tracker;
    this.hub = opts.hub;
    this.onTick = opts.onTick;
    this.clock = opts.clock ?? Date.now;
    this.graceMs = opts.graceMs ?? 60_000;
    this.tickMs = opts.tickMs ?? 15_000;
    this.sleepJumpMs = opts.sleepJumpMs ?? 60_000;
    this.idleThresholdMs = opts.idleThresholdMs ?? 600_000;
    this.log = opts.log ?? ((msg) => console.error(msg));
  }

  /** The latest report from the page, or null until the first one. */
  get current(): PresenceState | null {
    return this.presence ? { ...this.presence } : null;
  }

  /** Begins ticking and watching the connection count; runs one tick now, so `last_alive_at` is fresh. */
  start(): void {
    this.stopped = false;
    this.hub.onCountChange = this.handleCountChange;
    this.lastTick = this.clock();
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    this.tickTimer = unrefTimer(setInterval(() => this.tick(), this.tickMs));
    this.scheduleCheckin(this.lastTick, this.tracker.getState(this.lastTick));
    this.tick();
  }

  /** Clears every timer. Safe to call twice. */
  stop(): void {
    this.stopped = true;
    if (this.hub.onCountChange === this.handleCountChange) this.hub.onCountChange = null;
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.cancelGrace();
    this.cancelCheckin();
  }

  /** Ctrl+C: the running session ends now (DESIGN §6, "Server stopped"). Never throws. */
  shutdown(): void {
    try {
      const now = this.clock();
      const notice = this.tracker.autoPause(now, 'stopped', now);
      if (notice) {
        // Tabs may stay connected for a moment longer.
        this.hub.broadcast('autopause', notice);
        this.hub.broadcast('state', {});
      }
    } catch (err) {
      this.log(`Work Hours: could not pause on shutdown: ${describe(err)}`);
    }
    this.stop();
  }

  /** Call after ANY state-changing API action. */
  afterChange(): void {
    this.hub.broadcast('state', {});
    if (this.stopped) return;
    const now = this.clock();
    const state = this.tracker.getState(now);
    this.scheduleCheckin(now, state);
    // A Start can arrive with no tab connected (a notification button), so nothing else would
    // pause it if the tab never comes back.
    if (this.hub.count === 0 && this.graceTimer === null && state.running) {
      this.disconnectedAt = now;
      this.startGrace();
    }
  }

  /** POST /api/presence. The route has validated the input. Away detection, DESIGN §6.4. */
  report(p: PresenceRequest): void {
    const now = this.clock();
    const at = Math.min(Math.max(p.at, now - MAX_REPORT_AGE_MS), now);
    const prev = this.presence;
    this.presence = { user: p.user, screen: p.screen };

    let notice: AwayNotice | null = null;
    if (p.screen === 'locked' && prev?.screen !== 'locked') {
      notice = this.tracker.autoPause(now, 'locked', at);
    } else if (p.user === 'idle' && prev?.user !== 'idle') {
      // The page reports once the threshold has passed, so the last input was that long ago.
      notice = this.tracker.autoPause(now, 'idle', at - this.idleThresholdMs);
    }
    // This also runs afterChange().
    if (notice) this.afterAutoPause(notice);

    if (isPresent(p)) {
      const wasAway = prev !== null && !isPresent(prev);
      const ids = this.tracker.markReturned(now, at);
      // A first report after a page load is not a return, unless notices were waiting.
      if (ids.length > 0 || wasAway) this.hub.broadcast('returned', { at, sessionIds: ids });
      if (ids.length > 0) this.afterChange();
    }
  }

  // ---- Tab closed (DESIGN §6.1) ----

  private readonly handleCountChange = (count: number): void => {
    try {
      this.cancelGrace();
      if (count > 0 || this.stopped) return;
      const now = this.clock();
      this.disconnectedAt = now;
      if (this.tracker.getState(now).running) this.startGrace();
    } catch (err) {
      this.log(`Work Hours: could not handle a closed tab: ${describe(err)}`);
    }
  };

  private startGrace(): void {
    this.cancelGrace();
    this.graceTimer = unrefTimer(
      setTimeout(
        () =>
          this.guarded('tab-closed pause', () => {
            this.graceTimer = null;
            if (this.hub.count !== 0) return;
            const now = this.clock();
            const notice = this.tracker.autoPause(now, 'tab_closed', this.disconnectedAt);
            if (notice) this.afterAutoPause(notice);
          }),
        this.graceMs,
      ),
    );
  }

  private cancelGrace(): void {
    if (this.graceTimer !== null) clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  // ---- The 15 s tick (DESIGN §6.2) ----

  private tick(): void {
    const now = this.clock();
    try {
      if (now - this.lastTick > this.sleepJumpMs) {
        // The process was suspended, so the computer slept. The session ends at the tick before.
        const notice = this.tracker.autoPause(now, 'sleep', this.lastTick);
        if (notice) this.afterAutoPause(notice);
      }
      this.tracker.touchAlive(now);
    } catch (err) {
      this.logTickFailure(now, 'tick', err);
    }
    try {
      this.onTick?.(now);
    } catch (err) {
      this.logTickFailure(now, 'tick hook', err);
    }
    this.lastTick = now;
  }

  /** A tick that keeps failing would fill the log, so each day gets one line. */
  private logTickFailure(now: number, what: string, err: unknown): void {
    const day = localDay(now);
    if (day === this.tickFailureDay) return;
    this.tickFailureDay = day;
    this.log(
      `Work Hours: ${what} failed (further failures today are not logged): ${describe(err)}`,
    );
  }

  // ---- Automatic pauses ----

  /** Tells the tabs about a pause the server just made. */
  private afterAutoPause(notice: AwayNotice): void {
    this.hub.broadcast('autopause', notice);
    // The user is already back when the page reported active and unlocked before this pause
    // (the tick sees the computer's sleep only after it woke). A closed tab says nothing about
    // the user: the page that reported is gone, and "back" is when it reopens.
    if (isPresent(this.presence) && notice.reason !== 'tab_closed') {
      const now = this.clock();
      const sessionIds = this.tracker.markReturned(now, now);
      this.hub.broadcast('returned', { at: now, sessionIds });
    }
    this.afterChange();
  }

  // ---- Check-ins (DESIGN §7.2) ----

  /**
   * Arms one timer for the next multiple of the interval since the running session started,
   * so the schedule survives a restart of the timer and restarts with each new session.
   */
  private scheduleCheckin(now: number, state: AppState): void {
    this.cancelCheckin();
    const { running } = state;
    if (this.stopped || !running) return;
    const interval = state.settings.checkinMinutes * 60_000;
    const elapsed = Math.max(0, now - running.startedAt);
    const due = running.startedAt + (Math.floor(elapsed / interval) + 1) * interval;
    this.checkinTimer = unrefTimer(
      setTimeout(
        () => this.guarded('check-in', () => this.fireCheckin(due, running.sessionId)),
        due - now,
      ),
    );
  }

  private fireCheckin(due: number, sessionId: number): void {
    this.checkinTimer = null;
    const now = this.clock();
    const state = this.tracker.getState(now);
    // Early: the timer woke a moment before the minute, so the next schedule is this one again.
    // Late: the computer slept through it.
    const onTime = now >= due && now - due <= CHECKIN_LATE_MS;
    if (onTime && state.running?.sessionId === sessionId) {
      this.hub.broadcast('checkin', { projectId: state.running.projectId, sessionId });
    }
    this.scheduleCheckin(now, state);
  }

  private cancelCheckin(): void {
    if (this.checkinTimer !== null) clearTimeout(this.checkinTimer);
    this.checkinTimer = null;
  }

  // ---- Helpers ----

  /** A timer callback that throws would take the server down, so log instead. */
  private guarded(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.log(`Work Hours: ${what} failed: ${describe(err)}`);
    }
  }
}

function isPresent(p: PresenceState | null): boolean {
  return p !== null && p.user === 'active' && p.screen === 'unlocked';
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Lets the process exit with a timer pending (tests, shutdown). */
function unrefTimer<T>(handle: T): T {
  if (
    typeof handle === 'object' &&
    handle !== null &&
    'unref' in handle &&
    typeof handle.unref === 'function'
  ) {
    handle.unref();
  }
  return handle;
}
