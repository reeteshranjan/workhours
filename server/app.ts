import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import { APP_ID } from '../shared/types.js';
import type { ApiError, ErrorCode, EventName, HealthResponse } from '../shared/types.js';
import { localDay } from './db/index.js';
import type { EventHub } from './events.js';
import type { Presence } from './presence.js';
import { TrackerError } from './tracker/index.js';
import type { Tracker } from './tracker/index.js';

export interface AppOptions {
  port: number;
  version: string;
  /** The absolute path of the data folder (database and backups), shown in Settings (R8.4). */
  dataDir: string;
  /** The built UI, or null when it isn't built (under `npm run dev` Vite serves it). */
  webDir: string | null;
  tracker: Tracker;
  /** The open tabs (the live-events streams). */
  hub: EventHub;
  presence: Presence;
  /** The `now` handed to every tracker call. Defaults to the real clock. */
  clock?: () => number;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Ids in the URL are positive whole numbers that stay exact as a JS number. */
const ID_PATTERN = /^[1-9]\d{0,15}$/;

const KEEP_ALIVE_MS = 15_000;

/** Which HTTP status each of the tracker's error codes is sent with. */
function statusFor(code: ErrorCode): 400 | 404 | 409 {
  switch (code) {
    case 'not_found':
      return 404;
    case 'invalid_input':
    case 'invalid_name':
      return 400;
    default:
      return 409;
  }
}

function errorResponse(status: number, code: ErrorCode, message: string): Response {
  const body: ApiError = { error: { code, message } };
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Reads the request body as JSON. A body that isn't valid JSON (or is empty) throws an
 * HTTPException carrying the 400 response, which the app's error handler sends as is.
 */
export async function readJson(c: Context): Promise<unknown> {
  try {
    return (await c.req.json()) as unknown;
  } catch {
    throw new HTTPException(400, {
      res: errorResponse(400, 'invalid_input', "The request body isn't valid JSON."),
    });
  }
}

function invalidInput(message: string): HTTPException {
  return new HTTPException(400, { res: errorResponse(400, 'invalid_input', message) });
}

/** The request body, which must be a JSON object. */
async function readObject(c: Context): Promise<Record<string, unknown>> {
  const body = await readJson(c);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalidInput('The request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

/** A numeric id from the URL. Anything else can't name a row, so it is a 404. */
function idParam(c: Context, name: 'id' | 'sessionId'): number {
  const raw = c.req.param(name);
  if (raw === undefined || !ID_PATTERN.test(raw)) {
    throw new HTTPException(404, { res: errorResponse(404, 'not_found', 'Not found.') });
  }
  return Number(raw);
}

function isJsonContentType(value: string | undefined): boolean {
  return (value?.split(';')[0] ?? '').trim().toLowerCase() === 'application/json';
}

/** The file inside `root` that a URL path names, or null if the path escapes `root`. */
function resolveInside(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) {
    return null;
  }
  const target = resolve(root, decoded.replace(/^[/\\]+/, ''));
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    return null;
  }
  return target;
}

async function readFileIfExists(file: string): Promise<Buffer | null> {
  try {
    if (!(await stat(file)).isFile()) {
      return null;
    }
    return await readFile(file);
  } catch {
    return null;
  }
}

/** Serves a file from the built UI, falling back to index.html so the page's own routes work. */
async function serveWeb(webDir: string, urlPath: string): Promise<Response> {
  const target = resolveInside(webDir, urlPath);
  if (target === null) {
    return errorResponse(404, 'not_found', 'Not found.');
  }
  let file = target;
  let data = await readFileIfExists(file);
  if (data === null) {
    file = resolve(webDir, 'index.html');
    data = await readFileIfExists(file);
    if (data === null) {
      return errorResponse(404, 'not_found', 'Not found.');
    }
  }
  const rel = relative(webDir, file).split(sep).join('/');
  const immutable = rel.startsWith('assets/');
  return new Response(data, {
    headers: {
      'content-type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    },
  });
}

export function createApp(opts: AppOptions): Hono {
  const { tracker, hub, presence } = opts;
  const clock = opts.clock ?? Date.now;
  const allowedHosts = new Set([`localhost:${opts.port}`, `127.0.0.1:${opts.port}`]);
  const app = new Hono();

  // Outermost, so that the guards' own rejections carry the headers too.
  app.use('*', async (c, next) => {
    await next();
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
    c.res.headers.set('Referrer-Policy', 'no-referrer');
    c.res.headers.set('X-Frame-Options', 'DENY');
  });

  // DNS-rebinding guard (DESIGN §11).
  app.use('*', async (c, next) => {
    const host = c.req.header('host')?.toLowerCase();
    if (host === undefined || !allowedHosts.has(host)) {
      return errorResponse(403, 'forbidden_host', 'Requests must come from localhost.');
    }
    await next();
  });

  // With no CORS headers anywhere, a page on another site can only send "simple" cross-origin
  // requests, which can't carry JSON. Requiring JSON on state changes shuts those out.
  app.use('*', async (c, next) => {
    if (
      STATE_CHANGING_METHODS.has(c.req.method) &&
      !isJsonContentType(c.req.header('content-type'))
    ) {
      return errorResponse(415, 'json_required', 'Send JSON.');
    }
    await next();
  });

  app.get('/api/health', (c) => {
    const body: HealthResponse = { app: APP_ID, version: opts.version, dataDir: opts.dataDir };
    return c.json(body);
  });

  // ---- State ----

  app.get('/api/state', (c) => c.json(tracker.getState(clock())));

  /** Runs a state change, then tells the tabs and the timers, then answers with the new state. */
  function changeState(c: Context, run: (now: number) => void): Response {
    const now = clock();
    run(now);
    presence.afterChange();
    return c.json(tracker.getState(now));
  }

  // ---- Projects ----

  app.post('/api/projects', async (c) => {
    const { name } = await readObject(c);
    if (typeof name !== 'string') {
      throw invalidInput('"name" must be a string.');
    }
    const now = clock();
    tracker.addProject(now, name);
    presence.afterChange();
    return c.json(tracker.getState(now), 201);
  });

  // Declared before the `:id` routes below, though the paths can't clash.
  app.get('/api/projects/closed', (c) => c.json(tracker.getClosed(clock())));

  app.post('/api/projects/:id/start', (c) => {
    const id = idParam(c, 'id');
    return changeState(c, (now) => tracker.start(now, id));
  });

  app.post('/api/pause', (c) => changeState(c, (now) => tracker.pause(now)));

  app.post('/api/backdate', async (c) => {
    const { at } = await readObject(c);
    if (typeof at !== 'number' || !Number.isFinite(at)) {
      throw invalidInput('"at" must be a number.');
    }
    return changeState(c, (now) => tracker.backdate(now, at));
  });

  app.post('/api/projects/:id/reset', (c) => {
    const id = idParam(c, 'id');
    const now = clock();
    const result = tracker.reset(now, id);
    presence.afterChange();
    return c.json(result);
  });

  app.post('/api/projects/:id/adjust', async (c) => {
    const id = idParam(c, 'id');
    const { minutes, reason } = await readObject(c);
    if (typeof minutes !== 'number') {
      throw invalidInput('"minutes" must be a number.');
    }
    if (typeof reason !== 'string') {
      throw invalidInput('"reason" must be a string.');
    }
    return changeState(c, (now) => tracker.adjust(now, id, minutes, reason));
  });

  app.post('/api/projects/:id/close', (c) => {
    const id = idParam(c, 'id');
    const now = clock();
    const result = tracker.close(now, id);
    presence.afterChange();
    return c.json(result);
  });

  app.post('/api/projects/:id/reopen', (c) => {
    const id = idParam(c, 'id');
    return changeState(c, (now) => tracker.reopen(now, id));
  });

  app.get('/api/projects/:id/history', (c) => c.json(tracker.getHistory(idParam(c, 'id'))));

  // ---- Presence and away ----

  app.post('/api/presence', async (c) => {
    const { user, screen, at } = await readObject(c);
    if (user !== 'active' && user !== 'idle') {
      throw invalidInput('"user" must be "active" or "idle".');
    }
    if (screen !== 'locked' && screen !== 'unlocked') {
      throw invalidInput('"screen" must be "locked" or "unlocked".');
    }
    if (typeof at !== 'number' || !Number.isFinite(at)) {
      throw invalidInput('"at" must be a number.');
    }
    // It runs afterChange() itself when something changed.
    presence.report({ user, screen, at });
    return c.body(null, 204);
  });

  app.post('/api/away/:sessionId', async (c) => {
    const sessionId = idParam(c, 'sessionId');
    const { action } = await readObject(c);
    switch (action) {
      case 'count':
        return changeState(c, (now) => tracker.countAway(now, sessionId));
      case 'resume':
        return changeState(c, (now) => tracker.resumeAfterAway(now, sessionId));
      case 'dismiss':
        return changeState(c, (now) => tracker.dismissAway(now, sessionId));
      default:
        throw invalidInput('"action" must be "count", "resume" or "dismiss".');
    }
  });

  // ---- Settings ----

  app.get('/api/settings', (c) => c.json(tracker.getSettings()));

  app.put('/api/settings', async (c) => {
    const changes = await readObject(c);
    const settings = tracker.setSettings(changes);
    presence.afterChange();
    return c.json(settings);
  });

  // ---- Export ----

  app.get('/api/export', (c) => {
    const format = c.req.query('format');
    if (format !== 'json' && format !== 'csv') {
      throw invalidInput('"format" must be "json" or "csv".');
    }
    const now = clock();
    const filename = `workhours-${localDay(now)}.${format}`;
    const headers = { 'Content-Disposition': `attachment; filename="${filename}"` };
    if (format === 'csv') {
      return c.body(tracker.exportCsv(), 200, {
        ...headers,
        'Content-Type': 'text/csv; charset=utf-8',
      });
    }
    return c.body(JSON.stringify(tracker.exportJson(now), null, 2), 200, {
      ...headers,
      'Content-Type': 'application/json; charset=utf-8',
    });
  });

  // ---- Live events (DESIGN §6.1, §9.1) ----

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      const send = (name: EventName, data: unknown): void => {
        stream.writeSSE({ event: name, data: JSON.stringify(data) }).catch(() => undefined);
      };
      // Removing twice does nothing, so the abort and the end of the stream can both call it.
      const remove = hub.add({ send });
      let keepAlive: ReturnType<typeof setInterval> | undefined;
      try {
        // A tab that (re)connects refreshes itself.
        send('state', {});
        await new Promise<void>((resolve) => {
          stream.onAbort(() => {
            remove();
            resolve();
          });
          if (stream.aborted) {
            resolve();
            return;
          }
          keepAlive = setInterval(() => {
            void stream.write(': keep-alive\n\n');
          }, KEEP_ALIVE_MS);
        });
      } finally {
        clearInterval(keepAlive);
        remove();
      }
    }),
  );

  app.all('/api/*', () => errorResponse(404, 'not_found', 'Not found.'));

  const webDir = opts.webDir;
  if (webDir !== null) {
    app.get('*', (c) => serveWeb(webDir, new URL(c.req.url).pathname));
  }

  app.notFound(() => errorResponse(404, 'not_found', 'Not found.'));

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return err.getResponse();
    }
    if (err instanceof TrackerError) {
      const body: ApiError = {
        error: {
          code: err.code,
          message: err.message,
          ...(err.projectId !== undefined && { projectId: err.projectId }),
        },
      };
      return c.json(body, statusFor(err.code));
    }
    console.error(err);
    // No code: this is an unexpected error, not one the UI knows how to explain.
    return c.json({ error: { message: 'Something went wrong.' } }, 500);
  });

  return app;
}
