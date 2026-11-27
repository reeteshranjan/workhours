#!/usr/bin/env node
// The `workhours` command (DESIGN.md §3).
//
// Only Node built-ins that exist in Node 18 are imported statically, so that an old Node gets a
// clear message instead of a crash. Everything else is loaded after the version check.
import { mkdirSync } from 'node:fs';
import type { Server } from 'node:http';
import { get as httpGet } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';

const MIN_NODE_MAJOR = 24;
const DEFAULT_PORT = 7420;
const BIND_HOST = '127.0.0.1';

const USAGE = `Usage: workhours [options]

Options:
  --port <n>     Port to listen on (default ${DEFAULT_PORT})
  --data <dir>   Folder for the database and backups (default ~/.workhours)
  --no-open      Don't open Chrome
  -v, --version  Print the version
  -h, --help     Show this help`;

type Command =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'run'; port: number; dataDir: string; open: boolean };

class UsageError extends Error {}

function expandHome(dir: string): string {
  if (dir === '~' || dir.startsWith('~/') || dir.startsWith('~\\')) {
    return join(homedir(), dir.slice(1));
  }
  return dir;
}

function parseCli(argv: string[]): Command {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        port: { type: 'string' },
        data: { type: 'string' },
        'no-open': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  if (values.help) {
    return { kind: 'help' };
  }
  if (values.version) {
    return { kind: 'version' };
  }

  let port = DEFAULT_PORT;
  if (values.port !== undefined) {
    port = /^\d+$/.test(values.port) ? Number(values.port) : NaN;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new UsageError(`--port must be a whole number from 1 to 65535 (got "${values.port}").`);
    }
  }
  if (values.data !== undefined && values.data.trim() === '') {
    throw new UsageError('--data needs a folder.');
  }
  const dataDir = resolve(expandHome(values.data ?? join(homedir(), '.workhours')));
  return { kind: 'run', port, dataDir, open: values['no-open'] !== true };
}

/** True if something is already listening on the port. */
function portInUse(port: number): Promise<boolean> {
  return new Promise((resolvePromise, reject) => {
    const probe = createNetServer();
    probe.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolvePromise(true);
      } else {
        reject(err);
      }
    });
    probe.listen({ host: BIND_HOST, port }, () => {
      probe.close(() => resolvePromise(false));
    });
  });
}

/** True if the program on the port answers /api/health as Work Hours. */
function isWorkHours(port: number, appId: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const req = httpGet(
      {
        host: BIND_HOST,
        port,
        path: '/api/health',
        headers: { Host: `localhost:${port}` },
        timeout: 2000,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
          if (body.length > 10_000) {
            res.destroy();
            resolvePromise(false);
          }
        });
        res.on('end', () => {
          try {
            const parsed: unknown = JSON.parse(body);
            resolvePromise(
              typeof parsed === 'object' &&
                parsed !== null &&
                (parsed as { app?: unknown }).app === appId,
            );
          } catch {
            resolvePromise(false);
          }
        });
        res.on('error', () => resolvePromise(false));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolvePromise(false);
    });
    req.on('error', () => resolvePromise(false));
  });
}

/**
 * Opens the URL in Chrome. Never throws; if Chrome can't be opened it prints the URL instead.
 * Resolves once Chrome's launcher has finished (or after a few seconds), so a caller that is
 * about to exit can wait for the hint.
 */
async function openInChrome(url: string): Promise<void> {
  const hint = (): void => {
    console.log(`Open this in Google Chrome: ${url}`);
  };
  try {
    const { default: open, apps } = await import('open');
    const child = await open(url, { app: { name: apps.chrome } });
    await new Promise<void>((done) => {
      const timer = setTimeout(done, 3000);
      const finish = (failed: boolean): void => {
        clearTimeout(timer);
        if (failed) {
          hint();
        }
        done();
      };
      if (child.exitCode !== null) {
        finish(child.exitCode !== 0);
        return;
      }
      child.once('error', () => finish(true));
      child.once('exit', (code) => finish(code !== null && code !== 0));
    });
  } catch {
    hint();
  }
}

function portMessage(port: number): string {
  return `Port ${port} is used by another program. Try --port.`;
}

async function main(): Promise<void> {
  if (Number(process.versions.node.split('.')[0]) < MIN_NODE_MAJOR) {
    console.error(
      `Work Hours needs Node.js ${MIN_NODE_MAJOR} or newer (you have v${process.versions.node})`,
    );
    process.exitCode = 1;
    return;
  }

  let command: Command;
  try {
    command = parseCli(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`workhours: ${err.message}\n\n${USAGE}`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }
  if (command.kind === 'help') {
    console.log(USAGE);
    return;
  }

  const { findPackageRoot, readVersion, builtWebDir } = await import('./paths.js');
  const { APP_ID } = await import('../shared/types.js');
  const root = findPackageRoot();
  const version = readVersion(root);
  if (command.kind === 'version') {
    console.log(version);
    return;
  }

  const { port, dataDir } = command;
  const url = `http://localhost:${port}`;

  // Before touching the database: a second copy must never open it.
  if (await portInUse(port)) {
    if (await isWorkHours(port, APP_ID)) {
      console.log(`Work Hours is already running at ${url}`);
      if (command.open) {
        await openInChrome(url);
      }
    } else {
      console.error(portMessage(port));
      process.exitCode = 1;
    }
    return;
  }

  const { createApp } = await import('./app.js');
  const { backupIfDue, openDatabase } = await import('./db/index.js');
  const { EventHub } = await import('./events.js');
  const { Presence } = await import('./presence.js');
  const { Tracker } = await import('./tracker/index.js');
  const { serve } = await import('@hono/node-server');

  mkdirSync(dataDir, { recursive: true });
  const db = openDatabase(join(dataDir, 'workhours.db'));
  try {
    backupIfDue(db, dataDir, Date.now());
  } catch (err) {
    console.warn(
      `Warning: could not make today's backup: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // A session still open means the last run didn't stop cleanly (DESIGN §6.3).
  const tracker = new Tracker(db);
  const recovered = tracker.recoverFromCrash(Date.now());
  if (recovered) {
    console.log(`Paused ${recovered.projectName}: Work Hours wasn't stopped cleanly.`);
  }
  const hub = new EventHub();
  const presence = new Presence({
    tracker,
    hub,
    onTick: (now) => {
      backupIfDue(db, dataDir, now);
    },
  });

  const app = createApp({
    port,
    version,
    dataDir,
    webDir: builtWebDir(root),
    tracker,
    hub,
    presence,
  });
  let server: Server;
  try {
    server = await new Promise<Server>((resolvePromise, reject) => {
      const listening = serve({ fetch: app.fetch, hostname: BIND_HOST, port }, () => {
        listening.off('error', reject);
        resolvePromise(listening as Server);
      });
      listening.once('error', reject);
    });
  } catch (err) {
    db.close();
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      console.error(portMessage(port));
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  presence.start();
  let stopping = false;

  function finish(): void {
    try {
      db.close();
    } catch (err) {
      console.warn(`Warning: could not close the database: ${String(err)}`);
    }
    process.stdout.write('Work Hours stopped.\n', () => process.exit(0));
  }

  function shutdown(): void {
    // Before the connections close, or the count reaching 0 would start the tab-closed timer.
    presence.shutdown();
    server.close(() => {
      finish();
    });
    // Long-lived connections (the live-events stream) would otherwise keep close() waiting.
    server.closeAllConnections();
  }

  const onSignal = (): void => {
    if (stopping) {
      process.exit(1);
    }
    stopping = true;
    shutdown();
  };
  // SIGHUP is what a closing terminal window sends.
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);

  // Only now, with the handlers in place, so that anything watching the output can safely stop us.
  console.log(`Work Hours running at ${url}   (Ctrl+C to stop)`);
  if (command.open) {
    void openInChrome(url);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
