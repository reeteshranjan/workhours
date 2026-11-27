import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import type { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createApp } from '../../server/app.js';
import type { AppState } from '../../shared/types.js';
import { T0 } from '../unit/helpers.js';
import { makeDeps } from './helpers.js';
import type { Deps } from './helpers.js';

const TIMEOUT = 15_000;
const STATE_FRAME = 'event: state\ndata: {}';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls until `fn` returns true, or fails after `timeoutMs`. */
async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the condition.');
    await sleep(20);
  }
}

/** Reads an event stream one frame (the text up to a blank line) at a time. */
class Frames {
  private buffer = '';
  private readonly decoder = new TextDecoder();

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async next(timeoutMs = 3000): Promise<string> {
    for (;;) {
      const end = this.buffer.indexOf('\n\n');
      if (end !== -1) {
        const frame = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        return frame;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for a frame.')), timeoutMs);
      });
      try {
        const { done, value } = await Promise.race([this.reader.read(), timedOut]);
        if (done) throw new Error('The stream ended.');
        this.buffer += this.decoder.decode(value, { stream: true });
      } finally {
        clearTimeout(timer);
      }
    }
  }
}

describe('live events over HTTP', () => {
  let deps: Deps | undefined;
  let server: Server | undefined;
  let base = '';
  let port = 0;
  const controllers: AbortController[] = [];

  afterEach(async () => {
    for (const controller of controllers.splice(0)) controller.abort();
    deps?.presence.stop();
    await new Promise<void>((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
      server.closeAllConnections();
    });
    server = undefined;
    deps?.db.close();
    deps = undefined;
  });

  /** A real server on a free port. The tab-close grace period is short; nothing else ticks. */
  async function startServer(graceMs = 300): Promise<Deps> {
    const d = makeDeps({ graceMs, tickMs: 3_600_000 });
    deps = d;
    // start() is what wires the hub's connection count to the grace period.
    d.presence.start();
    const holder: { app?: Hono } = {};
    const listening = await new Promise<Server>((resolve) => {
      const s = serve(
        {
          fetch: (req) => holder.app?.fetch(req) ?? new Response(null, { status: 503 }),
          hostname: '127.0.0.1',
          port: 0,
        },
        () => resolve(s as Server),
      );
    });
    server = listening;
    port = (listening.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    holder.app = createApp({
      port,
      version: 'test',
      dataDir: '/data/workhours',
      webDir: null,
      tracker: d.tracker,
      hub: d.hub,
      presence: d.presence,
    });
    return d;
  }

  async function post(path: string, body: unknown = {}): Promise<Response> {
    return await fetch(`${base}/api${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function getState(): Promise<AppState> {
    return (await (await fetch(`${base}/api/state`)).json()) as AppState;
  }

  /** Opens GET /api/events. `abort()` closes the connection. */
  async function connect(): Promise<{ frames: Frames; abort: () => void; res: Response }> {
    const controller = new AbortController();
    controllers.push(controller);
    const res = await fetch(`${base}/api/events`, { signal: controller.signal });
    const reader = res.body?.getReader();
    if (!reader) throw new Error('No body.');
    return { frames: new Frames(reader), abort: () => controller.abort(), res };
  }

  async function addAndStart(name = 'Acme'): Promise<number> {
    const added = (await (await post('/projects', { name })).json()) as AppState;
    const id = added.projects.find((p) => p.name === name)?.id;
    if (id === undefined) throw new Error('not added');
    expect((await post(`/projects/${id}/start`)).status).toBe(200);
    return id;
  }

  test(
    'connecting sends a state frame first, and a change sends another',
    async () => {
      await startServer();
      const { frames, res } = await connect();
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(await frames.next()).toBe(STATE_FRAME);

      expect((await post('/projects', { name: 'Acme' })).status).toBe(201);
      expect(await frames.next()).toBe(STATE_FRAME);
    },
    TIMEOUT,
  );

  test(
    'every connected tab hears a change, and a failed change is silent',
    async () => {
      await startServer();
      const first = await connect();
      const second = await connect();
      expect(await first.frames.next()).toBe(STATE_FRAME);
      expect(await second.frames.next()).toBe(STATE_FRAME);

      expect((await post('/projects', { name: '' })).status).toBe(400);
      expect((await post('/projects', { name: 'Acme' })).status).toBe(201);
      expect(await first.frames.next()).toBe(STATE_FRAME);
      expect(await second.frames.next()).toBe(STATE_FRAME);
    },
    TIMEOUT,
  );

  test(
    'the hub counts open streams and drops each one once when it closes',
    async () => {
      const d = await startServer();
      const first = await connect();
      const second = await connect();
      await first.frames.next();
      await second.frames.next();
      expect(d.hub.count).toBe(2);

      first.abort();
      await waitFor(() => d.hub.count === 1);
      second.abort();
      await waitFor(() => d.hub.count === 0);
      // Nothing removes a client a second time.
      await sleep(100);
      expect(d.hub.count).toBe(0);
    },
    TIMEOUT,
  );

  test(
    'closing the last tab pauses the running project as tab_closed after the grace period',
    async () => {
      await startServer(300);
      const tab = await connect();
      await tab.frames.next();
      const id = await addAndStart();
      expect((await getState()).running?.projectId).toBe(id);

      const closedAt = Date.now();
      tab.abort();
      // Not paused at once: a reload would reconnect in time.
      await sleep(100);
      expect((await getState()).running?.projectId).toBe(id);

      await waitFor(async () => (await getState()).running === null);
      const pausedFor = Date.now() - closedAt;
      expect(pausedFor).toBeGreaterThanOrEqual(250);

      const state = await getState();
      expect(state.paused?.reason).toBe('tab_closed');
      expect(state.awayNotices).toHaveLength(1);
      expect(state.awayNotices[0]).toMatchObject({
        projectId: id,
        reason: 'tab_closed',
        returnedAt: null,
      });
      // The pause is backdated to the disconnect, not to the end of the grace period.
      const pausedAt = state.awayNotices[0]?.pausedAt ?? 0;
      expect(pausedAt).toBeGreaterThanOrEqual(closedAt);
      expect(Date.now() - pausedAt).toBeGreaterThanOrEqual(250);
    },
    TIMEOUT,
  );

  test(
    'a tab that reconnects within the grace period keeps the project running',
    async () => {
      await startServer(300);
      const first = await connect();
      await first.frames.next();
      const id = await addAndStart();

      first.abort();
      await sleep(100);
      const second = await connect();
      expect(await second.frames.next()).toBe(STATE_FRAME);

      await sleep(600);
      const state = await getState();
      expect(state.running?.projectId).toBe(id);
      expect(state.awayNotices).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    'starting a project with no tab connected pauses it too, once the grace period has passed',
    async () => {
      await startServer(300);
      const id = await addAndStart();
      expect((await getState()).running?.projectId).toBe(id);
      await waitFor(async () => (await getState()).running === null);
      expect((await getState()).awayNotices[0]?.reason).toBe('tab_closed');
    },
    TIMEOUT,
  );

  test(
    'the Host guard covers the event stream',
    async () => {
      await startServer();
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port, path: '/api/events', headers: { host: 'evil.example' } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(403);
      expect(deps?.hub.count).toBe(0);
    },
    TIMEOUT,
  );
});

describe('the event stream in process', () => {
  let deps: Deps | undefined;

  afterEach(() => {
    deps?.presence.stop();
    deps?.db.close();
    deps = undefined;
    vi.useRealTimers();
  });

  test('a keep-alive comment arrives every 15 seconds, and cancelling removes the client', async () => {
    vi.useFakeTimers({ now: T0 });
    const d = makeDeps();
    deps = d;
    const app = createApp({
      port: 7420,
      version: 'test',
      dataDir: '/data/workhours',
      webDir: null,
      tracker: d.tracker,
      hub: d.hub,
      presence: d.presence,
      clock: () => Date.now(),
    });
    const res = await app.request('/api/events', { headers: { host: 'localhost:7420' } });
    const reader = res.body?.getReader();
    if (!reader) throw new Error('No body.');
    const decoder = new TextDecoder();
    const read = async (): Promise<string> => {
      const { value } = await reader.read();
      return decoder.decode(value);
    };

    expect(await read()).toBe(`${STATE_FRAME}\n\n`);
    expect(d.hub.count).toBe(1);

    const keepAlive = read();
    await vi.advanceTimersByTimeAsync(14_999);
    await vi.advanceTimersByTimeAsync(1);
    expect(await keepAlive).toBe(': keep-alive\n\n');

    await reader.cancel();
    await vi.advanceTimersByTimeAsync(0);
    expect(d.hub.count).toBe(0);
    // The keep-alive timer is gone with the stream.
    expect(vi.getTimerCount()).toBe(0);
  });
});
