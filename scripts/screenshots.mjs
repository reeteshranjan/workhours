// Retakes the README's screenshots, docs/screenshot-light.png and docs/screenshot-dark.png, from
// the built app (`npm run screenshots` builds first). It makes up four projects in a throwaway
// database, runs the server on port 7499 so that a Work Hours in daily use (7420) isn't touched,
// starts one project and photographs the Active view in Chrome, 600 px wide, at 2x.
// It takes about 40 seconds, most of it waiting for the "Started earlier?" toast to go.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { openDatabase } from '../dist/server/db/index.js';

const root = join(import.meta.dirname, '..');
const PORT = 7499;
const ORIGIN = `http://localhost:${PORT}`;
const WIDTH = 600;
/** How long the "Started earlier?" toast stays after a Start (BackdateToast.svelte), plus a bit. */
const TOAST_MS = 32_000;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const now = Date.now();

/** Local time hh:mm:ss on the day `daysAgo` days before today. */
function localTime(daysAgo, hh, mm, ss = 0) {
  const d = new Date(now);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hh, mm, ss, 0);
  return d.getTime();
}

// ---- The made-up projects ----

/** When Data pipeline was switched to Acme Website, which runs from then on. */
const SWITCH_AT = now - 47 * MIN;

const projects = [
  { id: 1, name: 'Acme Website', createdAt: now - 31 * DAY },
  { id: 2, name: 'Data pipeline migration', createdAt: now - 30 * DAY },
  { id: 3, name: 'Blog redesign', createdAt: now - 14 * DAY },
  { id: 4, name: 'Mobile app audit', createdAt: now - 10 * DAY },
];
/** [project id, start, end, end reason], on separate stretches so that none overlap. */
const sessions = [
  ...[30, 28, 26, 24, 22].map((d) => [1, localTime(d, 9, 0), localTime(d, 16, 0), 'break']),
  [1, localTime(6, 9, 0), localTime(6, 10, 20), 'break'],
  ...[29, 27].map((d) => [2, localTime(d, 9, 30), localTime(d, 15, 30), 'break']),
  // The card reads "paused <time> · switched".
  [2, SWITCH_AT - (2 * HOUR + 10 * MIN + 23_000), SWITCH_AT, 'switch'],
  [3, localTime(13, 9, 0), localTime(13, 14, 30), 'break'],
  [3, localTime(12, 10, 0), localTime(12, 14, 50), 'break'],
  // The card reads "auto-paused yesterday 17:45 · screen locked", in amber.
  [3, localTime(1, 14, 10), localTime(1, 17, 45), 'locked'],
  [4, localTime(9, 9, 0), localTime(9, 13, 0), 'break'],
  // The card reads "paused <weekday> 18:05".
  [4, localTime(3, 13, 20), localTime(3, 18, 5, 12), 'break'],
].sort((a, b) => a[1] - b[1]);
/** [project id, when, minutes]: billed time, so that Current and Total differ. */
const resets = [
  [1, localTime(25, 18, 0), 825],
  [1, localTime(15, 18, 0), 1215],
  [2, localTime(21, 18, 0), 600],
  [3, localTime(8, 18, 0), 480],
];

function seed(dataDir) {
  const db = openDatabase(join(dataDir, 'workhours.db'));
  try {
    const addProject = db.prepare('INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)');
    for (const p of projects) {
      addProject.run(p.id, p.name, p.createdAt);
    }
    const addSession = db.prepare(
      'INSERT INTO sessions (project_id, started_at, ended_at, end_reason) VALUES (?, ?, ?, ?)',
    );
    // The automatic pause was dismissed, so it shows on its card but not in the status bar.
    const addAutoPause = db.prepare(
      `INSERT INTO auto_pauses (session_id, detected_at, returned_at, resolution, resolved_at)
       VALUES (?, ?, ?, 'dismissed', ?)`,
    );
    for (const [projectId, start, end, reason] of sessions) {
      const { lastInsertRowid } = addSession.run(projectId, start, end, reason);
      if (reason === 'locked') {
        addAutoPause.run(lastInsertRowid, end + 2_000, end + 40 * MIN, end + 41 * MIN);
      }
    }
    const addReset = db.prepare(
      'INSERT INTO resets (project_id, reset_at, minutes) VALUES (?, ?, ?)',
    );
    for (const [projectId, when, minutes] of resets) {
      addReset.run(projectId, when, minutes);
    }
  } finally {
    db.close();
  }
}

// ---- Server ----

async function api(method, path, body) {
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  }
  return response.status === 204 ? null : response.json();
}

/** Waits for the server, and checks that it is this script's and not another one on the port. */
async function waitForServer(server, dataDir) {
  for (let tries = 0; tries < 50; tries++) {
    if (server.exitCode !== null) {
      throw new Error(`The server exited (code ${server.exitCode}). Is port ${PORT} free?`);
    }
    try {
      const health = await api('GET', '/api/health');
      if (health.dataDir !== dataDir) {
        throw new Error(`Another Work Hours is running on port ${PORT} (${health.dataDir}).`);
      }
      return;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Another')) throw err;
      await sleep(200);
    }
  }
  throw new Error(`The server didn't answer on port ${PORT}.`);
}

// ---- Screenshots ----

/** A page with setup done, notifications and away detection allowed, and sound turned on. */
async function openPage(browser, colorScheme) {
  const context = await browser.newContext({
    viewport: { width: WIDTH, height: 900 },
    deviceScaleFactor: 2,
    colorScheme,
  });
  await context.addInitScript(`localStorage.setItem('workhours:setup-complete', '1');`);
  const page = await context.newPage();
  // As in tests/e2e/away.spec.ts: Playwright can't grant away detection, the DevTools protocol can.
  const tab = await context.newCDPSession(page);
  const { targetInfo } = await tab.send('Target.getTargetInfo');
  const chrome = await browser.newBrowserCDPSession();
  await chrome.send('Browser.grantPermissions', {
    permissions: ['idleDetection', 'notifications'],
    origin: ORIGIN,
    browserContextId: targetInfo.browserContextId,
  });
  // The computer taking the pictures may really be idle, which would pause the running project.
  await tab.send('Emulation.setIdleOverride', { isUserActive: true, isScreenUnlocked: true });
  await page.goto(`${ORIGIN}/`);
  // Any click turns sound on, which clears the "Sound is off" warning.
  await page.locator('header h1').click();
  await page.mouse.move(WIDTH - 10, 890);
  await page.locator('p.warning').waitFor({ state: 'detached', timeout: 10_000 });
  return page;
}

async function photograph(page, file) {
  await page.evaluate('document.fonts.ready.then(() => undefined)');
  const box = await page.locator('main').boundingBox();
  await page.screenshot({
    path: file,
    fullPage: true,
    animations: 'disabled',
    clip: { x: 0, y: 0, width: WIDTH, height: Math.ceil(box.y + box.height) },
  });
  console.log(`Saved ${file}`);
}

// ---- Run ----

const dataDir = mkdtempSync(join(tmpdir(), 'workhours-screenshots-'));
seed(dataDir);
const server = spawn(
  process.execPath,
  [join(root, 'dist', 'server', 'cli.js'), '--no-open', '--port', String(PORT), '--data', dataDir],
  { stdio: ['ignore', 'ignore', 'inherit'] },
);
const serverExited = new Promise((resolve) => server.once('exit', resolve));
let browser;
try {
  await waitForServer(server, dataDir);
  // Start Acme Website, then move its start back to the switch, as "Started earlier?" does.
  await api('POST', '/api/projects/1/start', {});
  const startedAt = Date.now();
  await api('POST', '/api/backdate', { at: SWITCH_AT });

  browser = await chromium.launch({ channel: 'chrome', headless: true });
  // Both pages stay open to the end, so the server never sees every tab closed.
  const pages = {
    light: await openPage(browser, 'light'),
    dark: await openPage(browser, 'dark'),
  };

  const wait = startedAt + TOAST_MS - Date.now();
  if (wait > 0) {
    console.log(`Waiting ${Math.ceil(wait / 1000)} s for the "Started earlier?" toast to go…`);
    await sleep(wait);
  }

  const state = await api('GET', '/api/state');
  if (state.running?.projectId !== 1 || state.awayNotices.length > 0) {
    throw new Error(`Unexpected state: ${JSON.stringify(state)}`);
  }
  for (const [scheme, page] of Object.entries(pages)) {
    await photograph(page, join(root, 'docs', `screenshot-${scheme}.png`));
  }
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await serverExited;
  rmSync(dataDir, { recursive: true, force: true });
}
