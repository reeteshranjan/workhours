import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventHub, type EventClient } from '../../server/events.js';
import { Presence, type PresenceOptions } from '../../server/presence.js';
import type { EventName, EventPayloads, PresenceRequest } from '../../shared/types.js';
import { MIN, T0, makeTracker, rows, sessions } from './helpers.js';

const HOUR = 60 * MIN;

interface Recorded {
  name: EventName;
  data: unknown;
}

/** Records every broadcast, whether or not any client is connected. */
class RecordingHub extends EventHub {
  readonly sent: Recorded[] = [];

  override broadcast<K extends EventName>(name: K, data: EventPayloads[K]): void {
    this.sent.push({ name, data });
    super.broadcast(name, data);
  }
}

function fakeClient(): EventClient & { received: Recorded[] } {
  const received: Recorded[] = [];
  return {
    received,
    send(name, data) {
      received.push({ name, data });
    },
  };
}

const started: Presence[] = [];

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});

afterEach(() => {
  for (const presence of started.splice(0)) presence.stop();
  vi.useRealTimers();
});

/** A started Presence on a real Tracker and hub. Time is the fake clock. */
function setup(opts: Partial<PresenceOptions> = {}) {
  const { db, t } = makeTracker();
  const hub = new RecordingHub();
  const log = vi.fn<(msg: string) => void>();
  const presence = new Presence({ tracker: t, hub, log, ...opts });
  started.push(presence);
  presence.start();

  return {
    db,
    t,
    hub,
    log,
    presence,
    /** Opens a tab. Call the result to close it again. */
    connect(): () => void {
      return hub.add(fakeClient());
    },
    /** The data of each broadcast of this event, in order. */
    events(name: EventName): unknown[] {
      return hub.sent.filter((e) => e.name === name).map((e) => e.data);
    },
    /** Adds a project and starts it now, the way the API does. */
    startProject(name = 'Acme'): number {
      const id = t.addProject(Date.now(), name).id;
      t.start(Date.now(), id);
      presence.afterChange();
      return id;
    },
    report(user: PresenceRequest['user'], screen: PresenceRequest['screen'], at = Date.now()) {
      presence.report({ user, screen, at });
    },
  };
}

function lastAlive(ctx: { db: Parameters<typeof rows>[0] }): number | undefined {
  const [row] = rows<{ value: string }>(
    ctx.db,
    "SELECT value FROM app_meta WHERE key = 'last_alive_at'",
  );
  return row ? Number(row.value) : undefined;
}

describe('tab closed', () => {
  it('pauses at the disconnect time once the tab has been gone for the grace period', () => {
    const ctx = setup();
    const closeTab = ctx.connect();
    const id = ctx.startProject();
    vi.advanceTimersByTime(5 * MIN);

    closeTab();
    vi.advanceTimersByTime(59_000);
    expect(sessions(ctx.db)[0]).toMatchObject({ ended_at: null, end_reason: null });

    vi.advanceTimersByTime(2_000);
    expect(sessions(ctx.db)[0]).toMatchObject({
      ended_at: T0 + 5 * MIN,
      end_reason: 'tab_closed',
    });
    expect(ctx.events('autopause')).toEqual([
      {
        sessionId: 1,
        projectId: id,
        projectName: 'Acme',
        reason: 'tab_closed',
        pausedAt: T0 + 5 * MIN,
        returnedAt: null,
        nextStartedAt: null,
      },
    ]);
    expect(ctx.events('state').length).toBeGreaterThan(1);
  });

  it('does nothing when a tab comes back within the grace period (a reload)', () => {
    const ctx = setup();
    const closeTab = ctx.connect();
    ctx.startProject();
    vi.advanceTimersByTime(5 * MIN);

    closeTab();
    vi.advanceTimersByTime(10_000);
    ctx.connect();
    vi.advanceTimersByTime(2 * MIN);

    expect(sessions(ctx.db)[0]?.ended_at).toBeNull();
    expect(ctx.events('autopause')).toEqual([]);
  });

  it('starts no timer when nothing is running as the last tab closes', () => {
    const ctx = setup();
    const closeTab = ctx.connect();
    closeTab();
    // Only the tick and no grace timer.
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(5 * MIN);
    expect(ctx.log).not.toHaveBeenCalled();
  });

  it('pauses a Start that arrives with no tab connected, at the start time', () => {
    const ctx = setup();
    const closeTab = ctx.connect();
    closeTab();
    vi.advanceTimersByTime(10 * MIN);

    ctx.startProject();
    vi.advanceTimersByTime(59_000);
    expect(sessions(ctx.db)[0]?.ended_at).toBeNull();
    vi.advanceTimersByTime(2_000);
    expect(sessions(ctx.db)[0]).toMatchObject({
      ended_at: T0 + 10 * MIN,
      end_reason: 'tab_closed',
    });
  });

  it('does not treat the closed tab as the user coming back', () => {
    const ctx = setup();
    const closeTab = ctx.connect();
    ctx.report('active', 'unlocked');
    const id = ctx.startProject();
    vi.advanceTimersByTime(5 * MIN);
    closeTab();
    vi.advanceTimersByTime(30 * MIN);

    expect(ctx.events('autopause')).toHaveLength(1);
    expect(ctx.events('returned')).toEqual([]);
    expect(ctx.t.getState(Date.now()).awayNotices[0]).toMatchObject({ returnedAt: null });

    // The reopened page is what brings the user back.
    ctx.connect();
    ctx.report('active', 'unlocked');
    expect(ctx.events('returned')).toEqual([{ at: Date.now(), sessionIds: [id] }]);
    expect(ctx.t.getState(Date.now()).awayNotices[0]).toMatchObject({ returnedAt: Date.now() });
  });
});

describe('tick', () => {
  it('writes last_alive_at when it starts and on every tick', () => {
    const ctx = setup();
    expect(lastAlive(ctx)).toBe(T0);
    vi.advanceTimersByTime(45_000);
    expect(lastAlive(ctx)).toBe(T0 + 45_000);
  });

  it('pauses as sleep, at the last tick before the clock jumped', () => {
    const ctx = setup();
    ctx.connect();
    const id = ctx.startProject();
    vi.advanceTimersByTime(MIN);
    expect(lastAlive(ctx)).toBe(T0 + MIN);

    vi.setSystemTime(Date.now() + 3 * HOUR);
    vi.advanceTimersByTime(15_000);

    expect(sessions(ctx.db)[0]).toMatchObject({ ended_at: T0 + MIN, end_reason: 'sleep' });
    expect(ctx.events('autopause')).toMatchObject([
      { sessionId: id, reason: 'sleep', pausedAt: T0 + MIN, returnedAt: null },
    ]);
    // The tick that found the jump still records that the process is alive.
    expect(lastAlive(ctx)).toBe(Date.now());
  });

  it('tells the page the user is back at once when the last report was active', () => {
    const ctx = setup();
    ctx.connect();
    ctx.report('active', 'unlocked');
    const id = ctx.startProject();
    vi.advanceTimersByTime(5 * MIN);

    vi.setSystemTime(Date.now() + 3 * HOUR);
    vi.advanceTimersByTime(15_000);

    const now = Date.now();
    expect(ctx.events('returned')).toEqual([{ at: now, sessionIds: [id] }]);
    expect(ctx.t.getState(now).awayNotices).toMatchObject([{ reason: 'sleep', returnedAt: now }]);
  });

  it('waits for the page to report when it was not active before the sleep', () => {
    const ctx = setup();
    ctx.connect();
    ctx.report('active', 'locked');
    ctx.startProject();
    vi.advanceTimersByTime(5 * MIN);

    vi.setSystemTime(Date.now() + 3 * HOUR);
    vi.advanceTimersByTime(15_000);

    expect(ctx.events('autopause')).toHaveLength(1);
    expect(ctx.events('returned')).toEqual([]);
  });

  it('calls onTick with the time of every tick, and logs a failing hook once per day', () => {
    const onTick = vi.fn<(now: number) => void>(() => {
      throw new Error('disk full');
    });
    const ctx = setup({ onTick });

    vi.advanceTimersByTime(MIN);
    expect(onTick.mock.calls.map(([now]) => now)).toEqual([
      T0,
      T0 + 15_000,
      T0 + 30_000,
      T0 + 45_000,
      T0 + MIN,
    ]);
    expect(ctx.log).toHaveBeenCalledTimes(1);
    expect(ctx.log.mock.calls[0]?.[0]).toContain('disk full');
    // The failing hook did not stop the heartbeat.
    expect(lastAlive(ctx)).toBe(T0 + MIN);

    vi.setSystemTime(Date.now() + 48 * HOUR);
    vi.advanceTimersByTime(15_000);
    expect(ctx.log).toHaveBeenCalledTimes(2);
  });
});

describe('presence reports', () => {
  it('has no current presence until the first report', () => {
    const ctx = setup();
    expect(ctx.presence.current).toBeNull();
    ctx.report('idle', 'unlocked');
    expect(ctx.presence.current).toEqual({ user: 'idle', screen: 'unlocked' });
  });

  it('pauses at the lock time, and records the return when unlocked', () => {
    const ctx = setup();
    ctx.connect();
    ctx.report('active', 'unlocked', T0);
    const id = ctx.startProject();
    vi.advanceTimersByTime(30 * MIN);
    const lockedAt = Date.now();

    ctx.report('active', 'locked', lockedAt);
    expect(sessions(ctx.db)[0]).toMatchObject({ ended_at: lockedAt, end_reason: 'locked' });
    expect(ctx.events('autopause')).toMatchObject([
      { sessionId: id, reason: 'locked', pausedAt: lockedAt, returnedAt: null },
    ]);
    expect(ctx.events('returned')).toEqual([]);

    vi.advanceTimersByTime(45 * MIN);
    ctx.report('active', 'unlocked', lockedAt + 45 * MIN);
    expect(ctx.events('returned')).toEqual([{ at: lockedAt + 45 * MIN, sessionIds: [id] }]);
    expect(ctx.t.getState(Date.now()).awayNotices).toMatchObject([
      { sessionId: id, returnedAt: lockedAt + 45 * MIN },
    ]);
  });

  it('pauses only when the screen becomes locked, not on every locked report', () => {
    const ctx = setup();
    ctx.connect();
    ctx.report('active', 'locked');
    ctx.startProject();
    ctx.report('active', 'locked');
    expect(sessions(ctx.db)[0]?.ended_at).toBeNull();
  });

  it('pauses idle as of the last input, ten minutes before the report', () => {
    const ctx = setup();
    ctx.connect();
    ctx.report('active', 'unlocked', T0);
    const id = ctx.startProject();
    vi.advanceTimersByTime(30 * MIN);
    const idleAt = Date.now();

    ctx.report('idle', 'unlocked', idleAt);
    expect(sessions(ctx.db)[0]).toMatchObject({ ended_at: idleAt - 10 * MIN, end_reason: 'idle' });
    expect(ctx.events('returned')).toEqual([]);

    vi.advanceTimersByTime(20 * MIN);
    ctx.report('active', 'unlocked', idleAt + 20 * MIN);
    expect(ctx.events('returned')).toEqual([{ at: idleAt + 20 * MIN, sessionIds: [id] }]);
  });

  it('keeps an idle pause from reaching back before the session started', () => {
    const ctx = setup();
    ctx.connect();
    ctx.report('active', 'unlocked', T0);
    vi.advanceTimersByTime(25 * MIN);
    ctx.startProject();
    vi.advanceTimersByTime(5 * MIN);

    ctx.report('idle', 'unlocked');
    expect(sessions(ctx.db)[0]).toMatchObject({
      started_at: T0 + 25 * MIN,
      ended_at: T0 + 25 * MIN,
      end_reason: 'idle',
    });
  });

  it('calls a report that is both locked and idle a lock, at the lock time', () => {
    const ctx = setup();
    ctx.connect();
    ctx.report('active', 'unlocked', T0);
    ctx.startProject();
    vi.advanceTimersByTime(30 * MIN);
    const at = Date.now() - MIN;

    ctx.report('idle', 'locked', at);
    expect(sessions(ctx.db)[0]).toMatchObject({ ended_at: at, end_reason: 'locked' });
    expect(ctx.events('autopause')).toHaveLength(1);
  });

  it('does not let a report claim a time in the future or more than a day ago', () => {
    const ctx = setup();
    ctx.connect();
    ctx.report('active', 'unlocked', T0);
    ctx.startProject();
    vi.advanceTimersByTime(MIN);

    ctx.report('active', 'locked', Date.now() + 5 * MIN);
    expect(sessions(ctx.db)[0]?.ended_at).toBe(T0 + MIN);
  });

  it('reports a return with no session ids when the user was away and nothing is pending', () => {
    const ctx = setup();
    ctx.connect();
    ctx.report('active', 'unlocked');
    ctx.report('idle', 'unlocked');
    expect(ctx.events('autopause')).toEqual([]);

    vi.advanceTimersByTime(5 * MIN);
    ctx.report('active', 'unlocked');
    expect(ctx.events('returned')).toEqual([{ at: Date.now(), sessionIds: [] }]);
  });

  it('does not count the first report of a page as a return', () => {
    const ctx = setup();
    ctx.connect();
    ctx.report('active', 'unlocked');
    ctx.report('active', 'unlocked');
    expect(ctx.events('returned')).toEqual([]);
  });

  it('reports a return for notices left by a crash, on the first report', () => {
    const ctx = setup();
    ctx.connect();
    const id = ctx.startProject();
    vi.advanceTimersByTime(10 * MIN);
    // What recoverFromCrash leaves behind; no page has reported yet.
    ctx.t.autoPause(Date.now(), 'stopped', T0 + 5 * MIN);
    expect(ctx.presence.current).toBeNull();

    ctx.report('active', 'unlocked');
    expect(ctx.events('returned')).toEqual([{ at: Date.now(), sessionIds: [id] }]);
    expect(ctx.t.getState(Date.now()).awayNotices).toMatchObject([{ returnedAt: Date.now() }]);
  });

  it('tells the tabs to refresh after a pause and after a return', () => {
    const ctx = setup();
    ctx.connect();
    ctx.report('active', 'unlocked');
    ctx.startProject();
    const before = ctx.events('state').length;
    ctx.report('active', 'locked');
    expect(ctx.events('state').length).toBeGreaterThan(before);
    const afterPause = ctx.events('state').length;
    ctx.report('active', 'unlocked');
    expect(ctx.events('state').length).toBeGreaterThan(afterPause);
  });
});

describe('check-in', () => {
  const checkins = (ctx: ReturnType<typeof setup>) => ctx.events('checkin');

  it('is sent every interval from the start of the session, and stops after a pause', () => {
    const ctx = setup();
    ctx.connect();
    const id = ctx.startProject();
    vi.advanceTimersByTime(10 * MIN - 1);
    expect(checkins(ctx)).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(checkins(ctx)).toEqual([{ projectId: id, sessionId: 1 }]);
    vi.advanceTimersByTime(10 * MIN);
    expect(checkins(ctx)).toHaveLength(2);

    ctx.t.pause(Date.now());
    ctx.presence.afterChange();
    vi.advanceTimersByTime(HOUR);
    expect(checkins(ctx)).toHaveLength(2);
  });

  it('counts again from the start of the new session after a switch', () => {
    const ctx = setup();
    ctx.connect();
    ctx.startProject('A');
    const b = ctx.t.addProject(Date.now(), 'B').id;
    vi.advanceTimersByTime(7 * MIN);
    ctx.t.start(Date.now(), b);
    ctx.presence.afterChange();

    vi.advanceTimersByTime(10 * MIN - 1);
    expect(checkins(ctx)).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(checkins(ctx)).toEqual([{ projectId: b, sessionId: 2 }]);
  });

  it('follows a changed interval at the next multiple from the session start', () => {
    const ctx = setup();
    ctx.connect();
    ctx.startProject();
    vi.advanceTimersByTime(12 * MIN);
    expect(checkins(ctx)).toHaveLength(1);

    ctx.t.setSettings({ checkinMinutes: 5 });
    ctx.presence.afterChange();
    vi.advanceTimersByTime(3 * MIN - 1);
    expect(checkins(ctx)).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(checkins(ctx)).toHaveLength(2); // At 15 minutes.
    vi.advanceTimersByTime(5 * MIN);
    expect(checkins(ctx)).toHaveLength(3);
  });

  it('is not sent when the timer fires over a minute late, but the schedule carries on', () => {
    // No tick, so the jump is not taken for a sleep that pauses the session first.
    const ctx = setup({ tickMs: 24 * HOUR });
    ctx.connect();
    ctx.startProject();

    vi.setSystemTime(Date.now() + HOUR);
    vi.advanceTimersByTime(10 * MIN);
    expect(checkins(ctx)).toEqual([]);

    // 70 minutes into the session, so the next one is due at 80.
    vi.advanceTimersByTime(10 * MIN);
    expect(checkins(ctx)).toHaveLength(1);
  });

  it('is not sent for a session that is no longer running', () => {
    const ctx = setup();
    ctx.connect();
    ctx.startProject();
    // Paused behind Presence's back, with no afterChange().
    ctx.t.pause(Date.now());
    vi.advanceTimersByTime(10 * MIN);
    expect(checkins(ctx)).toEqual([]);
  });
});

describe('shutdown and stop', () => {
  it('pauses as stopped, now, and clears every timer', () => {
    const ctx = setup();
    ctx.connect();
    const id = ctx.startProject();
    vi.advanceTimersByTime(20 * MIN);
    const sentBefore = ctx.hub.sent.length;

    ctx.presence.shutdown();
    expect(sessions(ctx.db)[0]).toMatchObject({ ended_at: T0 + 20 * MIN, end_reason: 'stopped' });
    expect(ctx.hub.sent.slice(sentBefore)).toMatchObject([
      { name: 'autopause', data: { sessionId: id, reason: 'stopped', pausedAt: T0 + 20 * MIN } },
      { name: 'state' },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does nothing visible when nothing is running, and never throws', () => {
    const ctx = setup();
    const sentBefore = ctx.hub.sent.length;
    expect(() => ctx.presence.shutdown()).not.toThrow();
    expect(ctx.hub.sent.length).toBe(sentBefore);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('logs instead of throwing when the pause fails', () => {
    const ctx = setup();
    vi.spyOn(ctx.t, 'autoPause').mockImplementation(() => {
      throw new Error('database is locked');
    });
    expect(() => ctx.presence.shutdown()).not.toThrow();
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('database is locked'));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('can be stopped twice, and starts no timers once stopped', () => {
    const ctx = setup();
    ctx.startProject();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    ctx.presence.stop();
    ctx.presence.stop();
    expect(vi.getTimerCount()).toBe(0);

    // A request that was still in flight, and a tab that drops.
    ctx.presence.afterChange();
    ctx.connect()();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('can be started again after stop', () => {
    const ctx = setup();
    ctx.presence.stop();
    ctx.presence.start();
    vi.advanceTimersByTime(15_000);
    expect(lastAlive(ctx)).toBe(T0 + 15_000);
  });
});

describe('EventHub', () => {
  it('broadcasts to every client', () => {
    const hub = new EventHub();
    const a = fakeClient();
    const b = fakeClient();
    hub.add(a);
    hub.add(b);

    hub.broadcast('returned', { at: 5, sessionIds: [1] });
    expect(a.received).toEqual([{ name: 'returned', data: { at: 5, sessionIds: [1] } }]);
    expect(b.received).toEqual(a.received);
  });

  it('drops a client that throws, still reaches the others, and reports the new count', () => {
    const hub = new EventHub();
    const counts: number[] = [];
    const bad: EventClient = {
      send() {
        throw new Error('broken pipe');
      },
    };
    const good = fakeClient();
    hub.add(bad);
    hub.add(good);
    hub.onCountChange = (count) => counts.push(count);

    hub.broadcast('state', {});
    expect(good.received).toHaveLength(1);
    expect(hub.count).toBe(1);
    expect(counts).toEqual([1]);

    hub.broadcast('state', {});
    expect(good.received).toHaveLength(2);
    expect(counts).toEqual([1]);
  });

  it('reports the count after each add and remove, and a second remove() does nothing', () => {
    const hub = new EventHub();
    const counts: number[] = [];
    hub.onCountChange = (count) => counts.push(count);

    const removeA = hub.add(fakeClient());
    const removeB = hub.add(fakeClient());
    expect(hub.count).toBe(2);
    removeA();
    removeA();
    expect(hub.count).toBe(1);
    removeB();
    expect(hub.count).toBe(0);
    expect(counts).toEqual([1, 2, 1, 0]);
  });

  it('keeps two connections of the same client apart', () => {
    const hub = new EventHub();
    const client = fakeClient();
    const remove = hub.add(client);
    hub.add(client);
    remove();
    expect(hub.count).toBe(1);
    hub.broadcast('state', {});
    expect(client.received).toHaveLength(1);
  });
});
