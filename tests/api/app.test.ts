import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { createApp, readJson } from '../../server/app.js';
import { makeDeps } from './helpers.js';

const PORT = 7420;
const HOST = `localhost:${PORT}`;
const DATA_DIR = '/data/workhours';

async function get(app: Hono, path: string, host: string | null = HOST): Promise<Response> {
  return await app.request(path, host === null ? {} : { headers: { host } });
}

function expectNoCors(res: Response): void {
  expect(res.headers.get('access-control-allow-origin')).toBeNull();
}

describe('host guard', () => {
  const app = createApp({
    port: PORT,
    version: '1.2.3',
    dataDir: DATA_DIR,
    webDir: null,
    ...makeDeps(),
  });

  test.each([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `LOCALHOST:${PORT}`])(
    'health answers for Host %s',
    async (host) => {
      const res = await get(app, '/api/health', host);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        app: 'work-hours',
        version: '1.2.3',
        dataDir: DATA_DIR,
      });
      expectNoCors(res);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    },
  );

  test.each(['evil.example', 'localhost:9999', 'localhost', 'localhost:7420.evil.example', null])(
    'rejects Host %s',
    async (host) => {
      const res = await get(app, '/api/health', host);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: { code: 'forbidden_host', message: 'Requests must come from localhost.' },
      });
      expectNoCors(res);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    },
  );

  test('rejects a bad Host before anything else, even a non-JSON state change', async () => {
    const res = await app.request('/api/x', {
      method: 'POST',
      headers: { host: 'evil.example', 'content-type': 'text/plain' },
      body: 'x',
    });
    expect(res.status).toBe(403);
  });
});

describe('JSON-only state changes', () => {
  const app = createApp({
    port: PORT,
    version: '1.2.3',
    dataDir: DATA_DIR,
    webDir: null,
    ...makeDeps(),
  });

  test('POST with text/plain is refused', async () => {
    const res = await app.request('/api/x', {
      method: 'POST',
      headers: { host: HOST, 'content-type': 'text/plain' },
      body: 'hello',
    });
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: { code: 'json_required', message: 'Send JSON.' } });
    expectNoCors(res);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('POST with no Content-Type is refused', async () => {
    const res = await app.request('/api/x', { method: 'POST', headers: { host: HOST } });
    expect(res.status).toBe(415);
  });

  test.each(['PUT', 'PATCH', 'DELETE'])('%s with a form encoding is refused', async (method) => {
    const res = await app.request('/api/x', {
      method,
      headers: { host: HOST, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'a=1',
    });
    expect(res.status).toBe(415);
    expectNoCors(res);
  });

  test.each(['application/json', 'application/json; charset=utf-8', 'Application/JSON'])(
    'POST with %s gets through (to a 404 JSON for an unknown route)',
    async (type) => {
      const res = await app.request('/api/x', {
        method: 'POST',
        headers: { host: HOST, 'content-type': type },
        body: '{}',
      });
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
      expectNoCors(res);
    },
  );

  test('GET needs no Content-Type', async () => {
    const res = await get(app, '/api/health');
    expect(res.status).toBe(200);
  });
});

describe('/api', () => {
  const app = createApp({
    port: PORT,
    version: '1.2.3',
    dataDir: DATA_DIR,
    webDir: null,
    ...makeDeps(),
  });

  test.each(['/api/nope', '/api/nope/deeper', '/api', '/api/'])(
    '%s is a 404 JSON',
    async (path) => {
      const res = await get(app, path);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
    },
  );

  test('without a built UI, / is a 404', async () => {
    const res = await get(app, '/');
    expect(res.status).toBe(404);
    expectNoCors(res);
  });

  test('responses carry the security headers', async () => {
    const res = await get(app, '/api/health');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
});

describe('static UI', () => {
  let root: string;
  let webDir: string;
  let app: Hono;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'workhours-web-'));
    webDir = join(root, 'web');
    mkdirSync(join(webDir, 'assets'), { recursive: true });
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>INDEX</title>');
    writeFileSync(join(webDir, 'sw.js'), '// service worker');
    writeFileSync(join(webDir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(join(webDir, 'assets', 'app-abc.js'), 'console.log("app");');
    // Beside webDir, not inside it: must never be served.
    writeFileSync(join(root, 'package.json'), '{"secret":"OUTSIDE"}');
    writeFileSync(join(root, 'secret.txt'), 'OUTSIDE');
    app = createApp({ port: PORT, version: '1.2.3', dataDir: DATA_DIR, webDir, ...makeDeps() });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('/ serves index.html without caching', async () => {
    const res = await get(app, '/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toContain('INDEX');
    expectNoCors(res);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  test('/assets/* is JS and cached for a year', async () => {
    const res = await get(app, '/assets/app-abc.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await res.text()).toBe('console.log("app");');
  });

  test('sw.js is not cached', async () => {
    const res = await get(app, '/sw.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  test('other files get their content type', async () => {
    const res = await get(app, '/favicon.svg');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
  });

  test('an unknown page falls back to index.html', async () => {
    const res = await get(app, '/closed');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toContain('INDEX');
  });

  test('HEAD works and has no body', async () => {
    const res = await app.request('/', { method: 'HEAD', headers: { host: HOST } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toBe('');
  });

  test.each([
    '/%2e%2e/%2e%2e/etc/passwd',
    '/..%2f..%2fpackage.json',
    '/..%2fsecret.txt',
    '/%2e%2e%2fsecret.txt',
    '/..%5csecret.txt',
    '/assets/..%2f..%2fsecret.txt',
    '/%00',
    '/%',
  ])('never serves anything from outside the web folder: %s', async (path) => {
    const res = await get(app, path);
    const body = await res.text();
    expect(body).not.toContain('OUTSIDE');
    expect(body).not.toContain('root:');
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) {
      expect(body).toContain('INDEX');
    }
  });

  test('/api/* is still a JSON 404, not index.html', async () => {
    const res = await get(app, '/api/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
  });

  test('a POST to a page is not served', async () => {
    const res = await app.request('/', {
      method: 'POST',
      headers: { host: HOST, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });

  test('the host guard covers static files too', async () => {
    const res = await get(app, '/', 'evil.example');
    expect(res.status).toBe(403);
  });
});

describe('errors', () => {
  // Later milestones add routes to this app; here the tests add a couple to reach the handlers.
  function appWithRoutes(): Hono {
    const app = createApp({
      port: PORT,
      version: '1.2.3',
      dataDir: DATA_DIR,
      webDir: null,
      ...makeDeps(),
    });
    app.post('/echo', async (c) => c.json({ got: await readJson(c) }));
    app.get('/boom', () => {
      throw new Error('kaboom');
    });
    return app;
  }

  async function post(app: Hono, body: string): Promise<Response> {
    return await app.request('/echo', {
      method: 'POST',
      headers: { host: HOST, 'content-type': 'application/json' },
      body,
    });
  }

  test('readJson returns the parsed body', async () => {
    const res = await post(appWithRoutes(), '{"a":1}');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ got: { a: 1 } });
  });

  test.each(['{oops', ''])('readJson turns a malformed body (%j) into a 400', async (body) => {
    const res = await post(appWithRoutes(), body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: 'invalid_input', message: "The request body isn't valid JSON." },
    });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('an unexpected error is a 500 with no code, and is logged', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await get(appWithRoutes(), '/boom');
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: { message: 'Something went wrong.' } });
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(log).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
  });
});
