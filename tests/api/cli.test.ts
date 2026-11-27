import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { localDay, openDatabase } from '../../server/db/index.js';

const ROOT = join(import.meta.dirname, '..', '..');
const TIMEOUT = 20_000;

interface Cli {
  child: ChildProcess;
  stdout(): string;
  stderr(): string;
  /** Resolves when the output (stdout) contains `text`. */
  waitForOutput(text: string): Promise<void>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

const children: ChildProcess[] = [];
const servers: Server[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
  for (const server of servers.splice(0)) {
    await new Promise<void>((done) => server.close(() => done()));
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'workhours-cli-'));
  dirs.push(dir);
  return dir;
}

/** A port nothing is listening on. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function startCli(args: string[]): Cli {
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/cli.ts', ...args], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let stdout = '';
  let stderr = '';
  const watchers: { text: string; done: () => void }[] = [];
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
    for (const watcher of watchers) {
      if (stdout.includes(watcher.text)) {
        watcher.done();
      }
    }
  });
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    waitForOutput: (text) =>
      new Promise<void>((resolve, reject) => {
        if (stdout.includes(text)) {
          resolve();
          return;
        }
        watchers.push({ text, done: resolve });
        void exited.then(() => {
          if (!stdout.includes(text)) {
            reject(
              new Error(`Exited before printing "${text}".\nstdout: ${stdout}\nstderr: ${stderr}`),
            );
          }
        });
      }),
    exited,
  };
}

/** Runs the CLI to completion. */
async function run(args: string[]) {
  const cli = startCli(args);
  const { code } = await cli.exited;
  return { code, stdout: cli.stdout(), stderr: cli.stderr() };
}

function runningLine(port: number): string {
  return `Work Hours running at http://localhost:${port}   (Ctrl+C to stop)`;
}

describe('workhours CLI', () => {
  test(
    'starts, serves /api/health and makes the database and today’s backup',
    async () => {
      const port = await freePort();
      const data = tempDir();
      const cli = startCli(['--no-open', '--port', String(port), '--data', data]);
      await cli.waitForOutput(runningLine(port));

      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(res.status).toBe(200);
      const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
        version: string;
      };
      // The data folder, as an absolute path (resolve() leaves an absolute --data as it is).
      expect(await res.json()).toEqual({ app: 'work-hours', version: pkg.version, dataDir: data });

      expect(existsSync(join(data, 'workhours.db'))).toBe(true);
      expect(existsSync(join(data, 'backups', `workhours-${localDay(Date.now())}.db`))).toBe(true);
    },
    TIMEOUT,
  );

  test(
    'a second copy on the same port says it is already running and exits 0',
    async () => {
      const port = await freePort();
      const first = startCli(['--no-open', '--port', String(port), '--data', tempDir()]);
      await first.waitForOutput(runningLine(port));

      const secondData = join(tempDir(), 'second');
      const second = await run(['--no-open', '--port', String(port), '--data', secondData]);
      expect(second.code).toBe(0);
      expect(second.stdout).toContain(`Work Hours is already running at http://localhost:${port}`);
      // It never got as far as opening a database.
      expect(existsSync(secondData)).toBe(false);

      // The first copy is unaffected.
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(res.status).toBe(200);
    },
    TIMEOUT,
  );

  test(
    'a port used by another program exits 1 with a message',
    async () => {
      const port = await freePort();
      const blocker = createHttpServer((_req, res) => {
        res.end('not work hours');
      });
      servers.push(blocker);
      await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', resolve));

      const data = join(tempDir(), 'data');
      const result = await run(['--no-open', '--port', String(port), '--data', data]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`Port ${port} is used by another program. Try --port.`);
      expect(existsSync(data)).toBe(false);
    },
    TIMEOUT,
  );

  test.skipIf(process.platform === 'win32')(
    'SIGINT stops it cleanly',
    async () => {
      const port = await freePort();
      const cli = startCli(['--no-open', '--port', String(port), '--data', tempDir()]);
      await cli.waitForOutput(runningLine(port));

      cli.child.kill('SIGINT');
      const { code } = await cli.exited;
      expect(code).toBe(0);
      expect(cli.stdout()).toContain('Work Hours stopped.');
    },
    TIMEOUT,
  );

  test.skipIf(process.platform === 'win32')(
    'SIGINT pauses the running project as stopped, even with a tab connected',
    async () => {
      const port = await freePort();
      const data = tempDir();
      const cli = startCli(['--no-open', '--port', String(port), '--data', data]);
      await cli.waitForOutput(runningLine(port));

      const base = `http://127.0.0.1:${port}/api`;
      const post = async (path: string, body: unknown): Promise<unknown> => {
        const res = await fetch(`${base}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(res.status).toBeLessThan(300);
        return await res.json();
      };
      const added = (await post('/projects', { name: 'Acme' })) as { projects: { id: number }[] };
      const id = added.projects[0]?.id;
      expect(id).toBeDefined();
      await post(`/projects/${id}/start`, {});

      // An open event stream must not keep the server from stopping.
      const stream = new AbortController();
      const events = await fetch(`${base}/events`, { signal: stream.signal });
      expect(events.status).toBe(200);
      const reader = events.body?.getReader();
      expect(new TextDecoder().decode((await reader?.read())?.value)).toContain('event: state');

      cli.child.kill('SIGINT');
      const { code } = await cli.exited;
      stream.abort();
      expect(code).toBe(0);
      expect(cli.stdout()).toContain('Work Hours stopped.');

      const db = openDatabase(join(data, 'workhours.db'));
      try {
        const sessions = db.prepare('SELECT project_id, ended_at, end_reason FROM sessions').all();
        expect(sessions).toHaveLength(1);
        expect(sessions[0]).toMatchObject({ project_id: id, end_reason: 'stopped' });
        expect(sessions[0]?.['ended_at']).toEqual(expect.any(Number));
        const pauses = db.prepare('SELECT session_id, resolution FROM auto_pauses').all();
        expect(pauses).toHaveLength(1);
        expect(pauses[0]).toMatchObject({ resolution: null });
      } finally {
        db.close();
      }
    },
    TIMEOUT,
  );

  test.each([['--port', '0'], ['--port', 'abc'], ['--port', '70000'], ['--bogus']])(
    'bad usage %j exits 2 and prints usage',
    async (...args) => {
      const result = await run(args);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('Usage: workhours');
    },
    TIMEOUT,
  );

  test(
    '--version prints the package version',
    async () => {
      const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
        version: string;
      };
      for (const flag of ['--version', '-v']) {
        const result = await run([flag]);
        expect(result.code).toBe(0);
        expect(result.stdout.trim()).toBe(pkg.version);
      }
    },
    TIMEOUT,
  );

  test(
    '--help lists the options and exits 0',
    async () => {
      const result = await run(['--help']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('--port <n>');
      expect(result.stdout).toContain('--data <dir>');
      expect(result.stdout).toContain('--no-open');
      expect(result.stdout).toContain('7420');
    },
    TIMEOUT,
  );
});
