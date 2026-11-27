import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createApp } from '../../server/app.js';
import { localDay } from '../../server/db/index.js';
import { formatLocalDateTime } from '../../server/tracker/index.js';
import type {
  ApiError,
  AppState,
  ClosedProject,
  CloseResult,
  ProjectHistory,
  ResetResult,
  Settings,
} from '../../shared/types.js';
import { MIN, T0 } from '../unit/helpers.js';
import { fakeClient, makeDeps } from './helpers.js';
import type { Deps, FakeClient } from './helpers.js';

const PORT = 7420;
const HOST = `localhost:${PORT}`;

let deps: Deps;
let app: Hono;
let client: FakeClient;

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  deps = makeDeps();
  // One connected tab, so that no tab-closed timer is armed (and so there is someone to hear events).
  client = fakeClient();
  deps.hub.add(client);
  app = createApp({
    port: PORT,
    version: '1.2.3',
    dataDir: '/data/workhours',
    webDir: null,
    tracker: deps.tracker,
    hub: deps.hub,
    presence: deps.presence,
    clock: () => Date.now(),
  });
});

afterEach(() => {
  deps.presence.stop();
  deps.db.close();
  vi.useRealTimers();
});

async function api(method: string, path: string, body?: unknown): Promise<Response> {
  return await app.request(`/api${path}`, {
    method,
    headers: { host: HOST, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function rawPost(path: string, body: string): Promise<Response> {
  return await app.request(`/api${path}`, {
    method: 'POST',
    headers: { host: HOST, 'content-type': 'application/json' },
    body,
  });
}

async function getState(): Promise<AppState> {
  return (await (await api('GET', '/state')).json()) as AppState;
}

/** Adds a project through the API and returns its id. */
async function addProject(name: string): Promise<number> {
  const res = await api('POST', '/projects', { name });
  expect(res.status).toBe(201);
  const project = ((await res.json()) as AppState).projects.find((p) => p.name === name);
  if (!project) throw new Error(`${name} was not added`);
  return project.id;
}

function stateEvents(): number {
  return client.received.filter((e) => e.name === 'state').length;
}

async function expectError(res: Response, status: number, code: string): Promise<ApiError> {
  expect(res.status).toBe(status);
  const body = (await res.json()) as ApiError;
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe('string');
  return body;
}

function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

describe('GET /api/state', () => {
  test('answers with the state as of the clock', async () => {
    const res = await api('GET', '/state');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      now: T0,
      running: null,
      paused: null,
      projects: [],
      awayNotices: [],
      lastAction: null,
      settings: { checkinMinutes: 10, volume: 0.6 },
    });
    expect(stateEvents()).toBe(0);
  });
});

describe('adding a project', () => {
  test('answers 201 with the new project in the state, and tells the tabs once', async () => {
    const res = await api('POST', '/projects', { name: '  Acme  ' });
    expect(res.status).toBe(201);
    const state = (await res.json()) as AppState;
    expect(state.projects).toEqual([
      {
        id: expect.any(Number) as number,
        name: 'Acme',
        createdAt: T0,
        currentMs: 0,
        totalMs: 0,
        lastPause: null,
      },
    ]);
    expect(stateEvents()).toBe(1);
  });

  test('a duplicate name (in any letter case) is 409 name_taken', async () => {
    await addProject('Acme');
    const before = stateEvents();
    const body = await expectError(
      await api('POST', '/projects', { name: 'ACME' }),
      409,
      'name_taken',
    );
    expect(body.error).not.toHaveProperty('projectId');
    expect(stateEvents()).toBe(before);
  });

  test('the name of a closed project is 409 name_taken_closed and names the project', async () => {
    const id = await addProject('Old');
    expect((await api('POST', `/projects/${id}/close`, {})).status).toBe(200);
    const body = await expectError(
      await api('POST', '/projects', { name: 'old' }),
      409,
      'name_taken_closed',
    );
    expect(body.error.projectId).toBe(id);
  });

  test.each(['', '   ', 'a\nb', 'x'.repeat(101)])(
    'the name %j is 400 invalid_name',
    async (name) => {
      await expectError(await api('POST', '/projects', { name }), 400, 'invalid_name');
      expect(stateEvents()).toBe(0);
    },
  );

  test.each([5, null, ['a'], { a: 1 }, true])('a name of %j is 400 invalid_input', async (name) => {
    await expectError(await api('POST', '/projects', { name }), 400, 'invalid_input');
  });

  test.each([[undefined], ['a string'], [[]], [null]])(
    'a body of %j is 400 invalid_input',
    async (body) => {
      await expectError(
        await rawPost('/projects', JSON.stringify(body) ?? ''),
        400,
        'invalid_input',
      );
    },
  );

  test.each(['{oops', ''])('malformed JSON (%j) is 400 invalid_input', async (body) => {
    const res = await rawPost('/projects', body);
    const error = await expectError(res, 400, 'invalid_input');
    expect(error.error.message).toBe("The request body isn't valid JSON.");
  });
});

describe('start, switch, pause and backdate', () => {
  test('a round trip, each step telling the tabs exactly once', async () => {
    const a = await addProject('A');
    const b = await addProject('B');
    let events = stateEvents();

    // Start A.
    let res = await api('POST', `/projects/${a}/start`, {});
    expect(res.status).toBe(200);
    let state = (await res.json()) as AppState;
    expect(state.now).toBe(T0);
    expect(state.running).toEqual({
      projectId: a,
      sessionId: expect.any(Number) as number,
      startedAt: T0,
    });
    expect(state.paused).toBeNull();
    expect(state.lastAction).toMatchObject({ kind: 'start', at: T0 });
    expect(stateEvents()).toBe(++events);

    // Switch to B after 5 minutes.
    advance(5 * MIN);
    res = await api('POST', `/projects/${b}/start`, {});
    state = (await res.json()) as AppState;
    expect(state.running).toMatchObject({ projectId: b, startedAt: T0 + 5 * MIN });
    expect(state.lastAction).toMatchObject({ kind: 'switch', at: T0 + 5 * MIN });
    expect(state.projects.find((p) => p.id === a)?.currentMs).toBe(5 * MIN);
    expect(stateEvents()).toBe(++events);

    // Pause after 3 more minutes.
    advance(3 * MIN);
    res = await api('POST', '/pause', {});
    expect(res.status).toBe(200);
    state = (await res.json()) as AppState;
    expect(state.running).toBeNull();
    expect(state.paused).toEqual({ since: T0 + 8 * MIN, reason: 'break', lastProjectId: b });
    expect(state.lastAction).toMatchObject({ kind: 'pause', at: T0 + 8 * MIN });
    expect(state.projects.find((p) => p.id === b)?.currentMs).toBe(3 * MIN);
    expect(stateEvents()).toBe(++events);

    // Move the pause back a minute.
    res = await api('POST', '/backdate', { at: T0 + 7 * MIN });
    expect(res.status).toBe(200);
    state = (await res.json()) as AppState;
    expect(state.paused?.since).toBe(T0 + 7 * MIN);
    expect(state.projects.find((p) => p.id === b)?.currentMs).toBe(2 * MIN);
    expect(stateEvents()).toBe(events + 1);

    // The page reads the same thing.
    expect(await getState()).toEqual(state);
  });

  test('start needs no body at all', async () => {
    const id = await addProject('A');
    const res = await app.request(`/api/projects/${id}/start`, {
      method: 'POST',
      headers: { host: HOST, 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as AppState).running?.projectId).toBe(id);
  });

  test('starting the running project again changes nothing but still answers 200', async () => {
    const id = await addProject('A');
    await api('POST', `/projects/${id}/start`, {});
    advance(MIN);
    const res = await api('POST', `/projects/${id}/start`, {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as AppState).running?.startedAt).toBe(T0);
  });

  test('starting an unknown project is 404, and a closed one is 409 not_active', async () => {
    await expectError(await api('POST', '/projects/999/start', {}), 404, 'not_found');
    const id = await addProject('A');
    await api('POST', `/projects/${id}/close`, {});
    await expectError(await api('POST', `/projects/${id}/start`, {}), 409, 'not_active');
  });

  test('pause with nothing running is fine', async () => {
    const res = await api('POST', '/pause', {});
    expect(res.status).toBe(200);
    expect((await res.json()) as AppState).toMatchObject({ running: null, paused: null });
  });

  test('backdate with nothing to move is 409 backdate_unavailable', async () => {
    await expectError(await api('POST', '/backdate', { at: T0 }), 409, 'backdate_unavailable');
    expect(stateEvents()).toBe(0);
  });

  test('backdate outside the allowed range is 409 backdate_out_of_range', async () => {
    const id = await addProject('A');
    await api('POST', `/projects/${id}/start`, {});
    advance(MIN);
    await expectError(
      await api('POST', '/backdate', { at: T0 - 13 * 60 * MIN }),
      409,
      'backdate_out_of_range',
    );
  });

  test.each([{}, { at: '5' }, { at: null }, { at: [1] }])(
    'backdate with %j is 400 invalid_input',
    async (body) => {
      await expectError(await api('POST', '/backdate', body), 400, 'invalid_input');
    },
  );
});

describe('reset', () => {
  test('answers with the hours and minutes it recorded', async () => {
    const id = await addProject('A');
    await api('POST', `/projects/${id}/start`, {});
    advance(90 * MIN + 20_000);
    const before = stateEvents();
    const res = await api('POST', `/projects/${id}/reset`, {});
    expect(res.status).toBe(200);
    expect((await res.json()) as ResetResult).toEqual({ hours: 1, minutes: 30 });
    expect(stateEvents()).toBe(before + 1);

    const state = await getState();
    expect(state.running).toBeNull();
    // The 20 leftover seconds stay in Current.
    expect(state.projects[0]).toMatchObject({ currentMs: 20_000 });
  });

  test('under a minute is 409 too_little_time, and a running timer keeps running', async () => {
    const id = await addProject('A');
    await api('POST', `/projects/${id}/start`, {});
    advance(30_000);
    const before = stateEvents();
    await expectError(await api('POST', `/projects/${id}/reset`, {}), 409, 'too_little_time');
    expect(stateEvents()).toBe(before);
    expect((await getState()).running?.projectId).toBe(id);
  });
});

describe('adjust', () => {
  test('adds minutes with a reason', async () => {
    const id = await addProject('A');
    const before = stateEvents();
    const res = await api('POST', `/projects/${id}/adjust`, { minutes: 30, reason: 'Phone call' });
    expect(res.status).toBe(200);
    const state = (await res.json()) as AppState;
    expect(state.projects[0]).toMatchObject({ currentMs: 30 * MIN, totalMs: 30 * MIN });
    expect(stateEvents()).toBe(before + 1);

    const history = (await (await api('GET', `/projects/${id}/history`)).json()) as ProjectHistory;
    expect(history.entries).toEqual([
      {
        kind: 'adjustment',
        id: expect.any(Number) as number,
        at: T0,
        minutes: 30,
        reason: 'Phone call',
      },
    ]);
  });

  test.each([
    { minutes: '5', reason: 'x' },
    { minutes: 5, reason: 5 },
    { minutes: 5 },
    { reason: 'x' },
    { minutes: null, reason: 'x' },
  ])('wrong types %j are 400 invalid_input', async (body) => {
    const id = await addProject('A');
    await expectError(await api('POST', `/projects/${id}/adjust`, body), 400, 'invalid_input');
    expect(stateEvents()).toBe(1);
  });

  test.each([
    { minutes: 0, reason: 'x' },
    { minutes: 1.5, reason: 'x' },
    { minutes: 100_001, reason: 'x' },
    { minutes: 5, reason: '   ' },
  ])('values %j are 400 invalid_input', async (body) => {
    const id = await addProject('A');
    await expectError(await api('POST', `/projects/${id}/adjust`, body), 400, 'invalid_input');
  });

  test('taking off more than there is is 409 would_go_negative', async () => {
    const id = await addProject('A');
    await api('POST', `/projects/${id}/adjust`, { minutes: 30, reason: 'x' });
    const before = stateEvents();
    await expectError(
      await api('POST', `/projects/${id}/adjust`, { minutes: -31, reason: 'oops' }),
      409,
      'would_go_negative',
    );
    expect(stateEvents()).toBe(before);
    const ok = await api('POST', `/projects/${id}/adjust`, { minutes: -30, reason: 'fine' });
    expect(ok.status).toBe(200);
  });

  test('an unknown project is 404', async () => {
    await expectError(
      await api('POST', '/projects/999/adjust', { minutes: 5, reason: 'x' }),
      404,
      'not_found',
    );
  });
});

describe('close, reopen, closed list and history', () => {
  test('close and reopen move a project in and out of the active list', async () => {
    const id = await addProject('A');
    await api('POST', `/projects/${id}/start`, {});
    advance(10 * MIN);
    const before = stateEvents();

    let res = await api('POST', `/projects/${id}/close`, {});
    expect(res.status).toBe(200);
    // Closing resets the 10 minutes first (R5.1), and answers with what it reset.
    expect((await res.json()) as CloseResult).toEqual({ reset: { hours: 0, minutes: 10 } });
    let state = await getState();
    expect(state.projects).toEqual([]);
    expect(state.running).toBeNull();
    expect(stateEvents()).toBe(before + 1);

    const closed = (await (await api('GET', '/projects/closed')).json()) as ClosedProject[];
    expect(closed).toEqual([{ id, name: 'A', closedAt: T0 + 10 * MIN, totalMs: 10 * MIN }]);
    const history = (await (await api('GET', `/projects/${id}/history`)).json()) as ProjectHistory;
    expect(history.entries).toEqual([{ kind: 'reset', id: 1, at: T0 + 10 * MIN, minutes: 10 }]);

    res = await api('POST', `/projects/${id}/reopen`, {});
    expect(res.status).toBe(200);
    state = (await res.json()) as AppState;
    expect(state.projects.map((p) => p.id)).toEqual([id]);
    expect(stateEvents()).toBe(before + 2);
    expect(await (await api('GET', '/projects/closed')).json()).toEqual([]);
  });

  test('closing with under a minute left answers reset null and records no reset', async () => {
    const id = await addProject('A');
    await api('POST', `/projects/${id}/start`, {});
    advance(40_000);

    const res = await api('POST', `/projects/${id}/close`, {});
    expect(res.status).toBe(200);
    expect((await res.json()) as CloseResult).toEqual({ reset: null });

    const closed = (await (await api('GET', '/projects/closed')).json()) as ClosedProject[];
    expect(closed).toEqual([{ id, name: 'A', closedAt: T0 + 40_000, totalMs: 40_000 }]);
    const history = (await (await api('GET', `/projects/${id}/history`)).json()) as ProjectHistory;
    expect(history.entries).toEqual([]);
  });

  test('closing a closed project is 409 not_active; reopening an active one is 409 not_closed', async () => {
    const id = await addProject('A');
    await expectError(await api('POST', `/projects/${id}/reopen`, {}), 409, 'not_closed');
    await api('POST', `/projects/${id}/close`, {});
    await expectError(await api('POST', `/projects/${id}/close`, {}), 409, 'not_active');
  });

  test('history lists resets and adjustments, newest first', async () => {
    const id = await addProject('A');
    await api('POST', `/projects/${id}/adjust`, { minutes: 90, reason: 'Before I started' });
    advance(MIN);
    await api('POST', `/projects/${id}/reset`, {});
    const res = await api('GET', `/projects/${id}/history`);
    expect(res.status).toBe(200);
    const history = (await res.json()) as ProjectHistory;
    expect(history).toMatchObject({ projectId: id, name: 'A' });
    expect(history.entries.map((e) => e.kind)).toEqual(['reset', 'adjustment']);
    expect(history.entries[0]).toMatchObject({ at: T0 + MIN, minutes: 90 });
  });

  test('history of an unknown project is 404', async () => {
    await expectError(await api('GET', '/projects/999/history'), 404, 'not_found');
  });

  test.each([
    ['POST', '/projects/abc/start'],
    ['POST', '/projects/0/start'],
    ['POST', '/projects/01/start'],
    ['POST', '/projects/-1/start'],
    ['POST', '/projects/1.5/start'],
    ['POST', '/projects/12345678901234567/start'],
    ['POST', '/projects/abc/reset'],
    ['POST', '/projects/abc/adjust'],
    ['POST', '/projects/abc/close'],
    ['POST', '/projects/abc/reopen'],
    ['GET', '/projects/abc/history'],
    ['POST', '/away/abc'],
    ['POST', '/away/0'],
  ])('%s /api%s is 404 not_found', async (method, path) => {
    await expectError(
      await api(
        method,
        path,
        method === 'POST' ? { minutes: 5, reason: 'x', action: 'count' } : undefined,
      ),
      404,
      'not_found',
    );
    expect(stateEvents()).toBe(0);
  });
});

describe('presence and away', () => {
  /** Starts a project and has the screen lock a minute later. Returns the paused session's id. */
  async function lockWhileRunning(): Promise<{ projectId: number; sessionId: number }> {
    const projectId = await addProject('A');
    await api('POST', `/projects/${projectId}/start`, {});
    advance(5 * MIN);
    const res = await api('POST', '/presence', {
      user: 'active',
      screen: 'locked',
      at: Date.now() - MIN,
    });
    expect(res.status).toBe(204);
    const notice = (await getState()).awayNotices[0];
    if (!notice) throw new Error('no away notice');
    return { projectId, sessionId: notice.sessionId };
  }

  test('a report is 204 and a lock pauses the running project', async () => {
    const projectId = await addProject('A');
    await api('POST', `/projects/${projectId}/start`, {});
    advance(5 * MIN);
    client.received.length = 0;

    const res = await api('POST', '/presence', {
      user: 'active',
      screen: 'locked',
      at: T0 + 4 * MIN,
    });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');

    const state = await getState();
    expect(state.running).toBeNull();
    expect(state.paused).toMatchObject({ reason: 'locked', since: T0 + 4 * MIN });
    expect(state.awayNotices).toEqual([
      {
        sessionId: expect.any(Number) as number,
        projectId,
        projectName: 'A',
        reason: 'locked',
        pausedAt: T0 + 4 * MIN,
        returnedAt: null,
        nextStartedAt: null,
      },
    ]);
    // The pause was announced once, and afterChange ran once (not twice) for it.
    expect(client.received.map((e) => e.name)).toEqual(['autopause', 'state']);
  });

  test('a report that changes nothing is 204 and tells no one', async () => {
    const res = await api('POST', '/presence', { user: 'active', screen: 'unlocked', at: T0 });
    expect(res.status).toBe(204);
    expect(client.received).toEqual([]);
  });

  test.each([
    {},
    { user: 'away', screen: 'locked', at: T0 },
    { user: 'active', screen: 'dark', at: T0 },
    { user: 'active', screen: 'locked', at: 'now' },
    { user: 'active', screen: 'locked' },
    { user: 'active', at: T0 },
  ])('a report of %j is 400 invalid_input', async (body) => {
    await expectError(await api('POST', '/presence', body), 400, 'invalid_input');
  });

  test('Count it keeps the time away, and the timer carries on', async () => {
    const { projectId, sessionId } = await lockWhileRunning();
    const before = stateEvents();
    const res = await api('POST', `/away/${sessionId}`, { action: 'count' });
    expect(res.status).toBe(200);
    const state = (await res.json()) as AppState;
    expect(state.awayNotices).toEqual([]);
    expect(state.running).toMatchObject({ projectId, sessionId });
    expect(stateEvents()).toBe(before + 1);
  });

  test('Resume starts the project again now, without the time away', async () => {
    const { projectId, sessionId } = await lockWhileRunning();
    const res = await api('POST', `/away/${sessionId}`, { action: 'resume' });
    expect(res.status).toBe(200);
    const state = (await res.json()) as AppState;
    expect(state.awayNotices).toEqual([]);
    expect(state.running).toMatchObject({ projectId, startedAt: Date.now() });
    expect(state.running?.sessionId).not.toBe(sessionId);
    // The paused session ended a minute before now, so 4 of the 5 minutes count.
    expect(state.projects[0]?.currentMs).toBe(4 * MIN);
  });

  test('Dismiss clears the notice and starts nothing', async () => {
    const { sessionId } = await lockWhileRunning();
    const res = await api('POST', `/away/${sessionId}`, { action: 'dismiss' });
    expect(res.status).toBe(200);
    const state = (await res.json()) as AppState;
    expect(state.awayNotices).toEqual([]);
    expect(state.running).toBeNull();
  });

  test('a second action on the same notice is 409 not_pending', async () => {
    const { sessionId } = await lockWhileRunning();
    expect((await api('POST', `/away/${sessionId}`, { action: 'count' })).status).toBe(200);
    const before = stateEvents();
    await expectError(
      await api('POST', `/away/${sessionId}`, { action: 'dismiss' }),
      409,
      'not_pending',
    );
    await expectError(
      await api('POST', `/away/${sessionId}`, { action: 'count' }),
      409,
      'not_pending',
    );
    expect(stateEvents()).toBe(before);
  });

  test('an unknown session is 409 not_pending', async () => {
    await expectError(await api('POST', '/away/999', { action: 'count' }), 409, 'not_pending');
  });

  test.each([{ action: 'bogus' }, { action: 5 }, {}])(
    'an action of %j is 400 invalid_input',
    async (body) => {
      const { sessionId } = await lockWhileRunning();
      await expectError(await api('POST', `/away/${sessionId}`, body), 400, 'invalid_input');
      // Still pending.
      expect((await getState()).awayNotices).toHaveLength(1);
    },
  );
});

describe('settings', () => {
  test('GET answers with the defaults', async () => {
    const res = await api('GET', '/settings');
    expect(res.status).toBe(200);
    expect((await res.json()) as Settings).toEqual({ checkinMinutes: 10, volume: 0.6 });
  });

  test('PUT changes the given settings, keeps the rest, and tells the tabs once', async () => {
    let res = await api('PUT', '/settings', { checkinMinutes: 5 });
    expect(res.status).toBe(200);
    expect((await res.json()) as Settings).toEqual({ checkinMinutes: 5, volume: 0.6 });
    expect(stateEvents()).toBe(1);

    res = await api('PUT', '/settings', { volume: 0.9 });
    expect((await res.json()) as Settings).toEqual({ checkinMinutes: 5, volume: 0.9 });
    expect(stateEvents()).toBe(2);

    expect(await (await api('GET', '/settings')).json()).toEqual({
      checkinMinutes: 5,
      volume: 0.9,
    });
    expect((await getState()).settings).toEqual({ checkinMinutes: 5, volume: 0.9 });
  });

  test.each([
    { checkinMinutes: 7 },
    { checkinMinutes: '5' },
    { volume: 0.1 },
    { volume: 1.5 },
    { volume: 'loud' },
    { bogus: 1 },
  ])('PUT %j is 400 invalid_input and changes nothing', async (body) => {
    await expectError(await api('PUT', '/settings', body), 400, 'invalid_input');
    expect(await (await api('GET', '/settings')).json()).toEqual({
      checkinMinutes: 10,
      volume: 0.6,
    });
    expect(stateEvents()).toBe(0);
  });

  test('PUT with something that is not an object is 400 invalid_input', async () => {
    const res = await app.request('/api/settings', {
      method: 'PUT',
      headers: { host: HOST, 'content-type': 'application/json' },
      body: '[]',
    });
    await expectError(res, 400, 'invalid_input');
  });
});

describe('export', () => {
  async function withOneReset(): Promise<void> {
    const id = await addProject('Acme, Inc.');
    await api('POST', `/projects/${id}/adjust`, { minutes: 95, reason: 'x' });
    advance(MIN);
    await api('POST', `/projects/${id}/reset`, {});
  }

  test('JSON is an attachment, pretty-printed, and parses', async () => {
    await withOneReset();
    const res = await api('GET', '/export?format=json');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="workhours-${localDay(Date.now())}.json"`,
    );
    expect(res.headers.get('content-type')).toContain('application/json');
    const text = await res.text();
    expect(text).toContain('\n  "app": "work-hours"');
    const parsed = JSON.parse(text) as Record<string, unknown[]>;
    expect(parsed['app']).toBe('work-hours');
    expect(parsed['projects']).toHaveLength(1);
    expect(parsed['resets']).toHaveLength(1);
  });

  test('CSV is an attachment with the header row and one row per reset', async () => {
    await withOneReset();
    const res = await api('GET', '/export?format=csv');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="workhours-${localDay(Date.now())}.csv"`,
    );
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    const lines = (await res.text()).trimEnd().split('\n');
    expect(lines).toEqual([
      'project,date,hours,minutes',
      `"Acme, Inc.",${formatLocalDateTime(T0 + MIN)},1,35`,
    ]);
  });

  test.each(['/export?format=xml', '/export?format=', '/export', '/export?format=JSON'])(
    'GET /api%s is 400 invalid_input',
    async (path) => {
      await expectError(await api('GET', path), 400, 'invalid_input');
    },
  );
});

describe('the JSON-only rule on the real routes', () => {
  test.each([
    ['POST', '/pause'],
    ['POST', '/projects'],
    ['PUT', '/settings'],
  ])('%s /api%s with text/plain is 415 json_required', async (method, path) => {
    const res = await app.request(`/api${path}`, {
      method,
      headers: { host: HOST, 'content-type': 'text/plain' },
      body: '{}',
    });
    await expectError(res, 415, 'json_required');
    expect(deps.tracker.getState(Date.now()).projects).toEqual([]);
    expect(stateEvents()).toBe(0);
  });
});
