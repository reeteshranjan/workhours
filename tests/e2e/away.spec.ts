// End-to-end tests of real away detection (DESIGN §6.4, §7.2), in Chrome against the built app:
// the page's own IdleDetector, driven through the DevTools protocol, reports to the server, which
// pauses the timer, and the page raises the alerts when the user is back.
//
// Chrome won't let a test grant the idle-detection permission through Playwright, so the tests
// grant it with a DevTools command and fake what the computer reports with Emulation.setIdleOverride.
// What can't be tested here: the 10-minute threshold (the emulation reports "idle" at once), so
// neither the backdating of an idle pause nor the check-in chime is covered (the unit tests of the
// server cover both with a clock they control); and how a real notification looks on the user's
// computer.
import { expect, test as base } from '@playwright/test';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import type { AppState, CloseResult } from '../../shared/types.js';
import { screenshot, skipSetup } from './helpers.js';

const ORIGIN = 'http://localhost:7498';

// ---- API helper ----

function makeApi(request: APIRequestContext) {
  // POST always carries a JSON body: the server rejects anything else (DESIGN §11).
  async function send<T>(method: 'GET' | 'POST', path: string, data: object = {}): Promise<T> {
    const response = await request.fetch(path, {
      method,
      ...(method === 'POST' && { data }),
    });
    expect(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`).toBe(
      true,
    );
    return (response.status() === 204 ? undefined : await response.json()) as T;
  }

  return {
    state: () => send<AppState>('GET', '/api/state'),
    async addProject(name: string): Promise<number> {
      const state = await send<AppState>('POST', '/api/projects', { name });
      const project = state.projects.find((p) => p.name === name);
      if (!project) throw new Error(`"${name}" is not in the state after adding it`);
      return project.id;
    },
    start: (id: number) => send<AppState>('POST', `/api/projects/${id}/start`),
    pause: () => send<AppState>('POST', '/api/pause'),
    close: (id: number) => send<CloseResult>('POST', `/api/projects/${id}/close`),
    presence: (user: 'active' | 'idle', screen: 'locked' | 'unlocked') =>
      send<undefined>('POST', '/api/presence', { user, screen, at: Date.now() }),
    away: (sessionId: number, action: 'count' | 'resume' | 'dismiss') =>
      send<AppState>('POST', `/api/away/${sessionId}`, { action }),
  };
}

type Api = ReturnType<typeof makeApi>;

/** Nothing running, no away notices, no active projects, and the user present. */
async function clearApp(api: Api): Promise<void> {
  const state = await api.state();
  if (state.running) await api.pause();
  for (const notice of state.awayNotices) await api.away(notice.sessionId, 'dismiss');
  for (const project of state.projects) await api.close(project.id);
  await api.presence('active', 'unlocked');
}

/**
 * Records every notification the page asks the service worker to show, in `window.shown`. The
 * test browser has no notification centre to look in, and its own list of shown notifications is
 * not reliable.
 */
const RECORD_NOTIFICATIONS = `(() => {
  window.shown = [];
  const show = ServiceWorkerRegistration.prototype.showNotification;
  ServiceWorkerRegistration.prototype.showNotification = function (title, options) {
    window.shown.push({ title, ...options });
    return show.call(this, title, options);
  };
})();`;

// ---- The faked computer ----

type User = 'active' | 'idle';
type Screen = 'locked' | 'unlocked';

interface Idle {
  /** What Chrome tells the page's IdleDetector from now on. */
  set(user: User, screen: Screen): Promise<void>;
}

const test = base.extend<{ api: Api; idle: Idle }>({
  api: async ({ request }, use) => {
    await use(makeApi(request));
  },

  // Set up before the page opens, so the detector starts as soon as the page asks for it.
  idle: [
    async ({ browser, context, page }, use) => {
      // A DevTools session on the page sets the override. Granting a permission is a browser-level
      // command, and has to name the context: without it, Chrome's default context gets the
      // permission and not the one the test runs in. One command grants everything, because a
      // second one for the same origin replaces the first.
      const tab = await context.newCDPSession(page);
      const { targetInfo } = await tab.send('Target.getTargetInfo');
      const browserContextId = targetInfo.browserContextId;
      const chrome = await browser.newBrowserCDPSession();
      await chrome.send('Browser.grantPermissions', {
        permissions: ['idleDetection', 'notifications'],
        origin: ORIGIN,
        browserContextId,
      });

      const set = async (user: User, screen: Screen): Promise<void> => {
        await tab.send('Emulation.setIdleOverride', {
          isUserActive: user === 'active',
          isScreenUnlocked: screen === 'unlocked',
        });
      };
      // The computer running the tests may really be idle, which would be reported at start.
      await set('active', 'unlocked');

      await use({ set });

      try {
        await tab.send('Emulation.clearIdleOverride');
        await chrome.send('Browser.resetPermissions', { browserContextId });
      } finally {
        await chrome.detach();
      }
    },
    { auto: true },
  ],
});

test.beforeEach(async ({ api, context }) => {
  await clearApp(api);
  // The welcome dialog is for a first run, and these tests are about away detection.
  await skipSetup(context);
  await context.addInitScript(RECORD_NOTIFICATIONS);
});

// ---- Page helpers ----

let counter = 0;
/**
 * A project name no other test uses, even though closed projects keep their names: the counter
 * separates the tests in this file, and "Away" the other files, which share the database.
 */
function uniqueName(label: string): string {
  counter += 1;
  return `Away ${label} #${counter}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface Shown {
  title: string;
  body: string;
  tag: string;
  actions?: { action: string; title: string }[];
}

/** The notifications this page has shown, oldest first. */
async function shown(page: Page): Promise<Shown[]> {
  return (await page.evaluate('window.shown')) as Shown[];
}

async function shownWithTag(page: Page, tag: string): Promise<Shown[]> {
  return (await shown(page)).filter((n) => n.tag === tag);
}

interface Report {
  user: User;
  screen: Screen;
}

/** Collects what this page sends to POST /api/presence (the first is the detector's own start). */
function watchPresence(page: Page): Report[] {
  const reports: Report[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/presence')) {
      const { user, screen } = JSON.parse(request.postData() ?? '{}') as Report;
      reports.push({ user, screen });
    }
  });
  return reports;
}

/**
 * Opens the app in the first tab, which becomes the alert leader, and waits until its detector
 * has started: the start is reported to the server like every change.
 */
async function openAsLeader(page: Page): Promise<Report[]> {
  const reports = watchPresence(page);
  await page.goto('/');
  await expect(page.getByLabel('New project name')).toBeVisible();
  await expect.poll(() => reports.length, { message: 'the detector reported its start' }).toBe(1);
  expect(reports[0]).toEqual({ user: 'active', screen: 'unlocked' });
  return reports;
}

function card(page: Page, name: string): Locator {
  return page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });
}

function runningBadge(scope: Locator | Page): Locator {
  return scope.getByText('running', { exact: true });
}

function statusBar(page: Page): Locator {
  return page.getByRole('region', { name: 'Status' });
}

/** The pending automatic pause in the status bar. Its warning line has role=status too. */
function awayNotice(page: Page): Locator {
  return statusBar(page).getByRole('status').filter({ hasText: 'auto-paused' });
}

/** A project that is running, in the first tab. */
async function startProject(api: Api, label: string): Promise<string> {
  const name = uniqueName(label);
  await api.start(await api.addProject(name));
  return name;
}

// ---- Tests ----

test('Lock, auto-pause, back: the notice, the status bar, the notification, and Count', async ({
  page,
  api,
  idle,
}) => {
  const name = await startProject(api, 'Acme Website');
  const reports = await openAsLeader(page);
  await expect(runningBadge(card(page, name))).toBeVisible();

  // The screen locks: the detector says so, and the server ends the session at that moment.
  await idle.set('active', 'locked');
  await expect.poll(async () => (await api.state()).running).toBeNull();
  const locked = (await api.state()).awayNotices;
  expect(locked).toHaveLength(1);
  expect(locked[0]).toMatchObject({ projectName: name, reason: 'locked', returnedAt: null });
  expect(reports.at(-1)).toEqual({ user: 'active', screen: 'locked' });

  const notice = awayNotice(page);
  await expect(notice).toContainText(name);
  await expect(notice).toContainText(/auto-paused \d\d:\d\d\s*·\s*screen locked/);
  await expect(runningBadge(page)).toHaveCount(0);
  // The user isn't back yet, so there is nothing to alert about.
  expect(await shownWithTag(page, 'away')).toEqual([]);

  // The screen unlocks: the server marks the pause as returned, and the leader raises the alert.
  await idle.set('active', 'unlocked');
  await expect.poll(async () => (await api.state()).awayNotices[0]?.returnedAt).not.toBeNull();
  await expect.poll(async () => (await shownWithTag(page, 'away')).length).toBe(1);

  const [alert] = await shownWithTag(page, 'away');
  expect(alert?.title).toMatch(new RegExp(`^${escapeRegExp(name)} auto-paused \\d\\d:\\d\\d$`));
  expect(alert?.body).toMatch(/^screen locked · away \d+m$/);
  expect(alert?.actions?.map((a) => a.action)).toEqual(['count', 'resume']);
  expect(alert?.actions?.map((a) => a.title)).toEqual([
    expect.stringMatching(/^Count the \d+m$/),
    'Resume',
  ]);
  // Nothing else was shown: the pause was not a "Nothing is running" case.
  expect(await shown(page)).toHaveLength(1);

  await expect(notice).toContainText(name);
  await screenshot(page, 'away-real.png');

  // The status bar offers the same choices as the notification: count the time, and the project runs.
  await notice.getByRole('button', { name: /^Count the \d+m$/ }).click();
  await expect(notice).toHaveCount(0);
  await expect(runningBadge(card(page, name))).toBeVisible();
  const after = await api.state();
  expect(after.running?.projectId).toBe(
    after.projects.find((p) => p.name === name)?.id ?? Number.NaN,
  );
  expect(after.awayNotices).toEqual([]);
});

test('Idle with nothing running, then back: "Nothing is running" and Resume', async ({
  page,
  api,
  idle,
}) => {
  // A project ran and was paused, so there is a last project to resume.
  const name = await startProject(api, 'Data pipeline');
  await api.pause();
  const state = await api.state();
  expect(state.running).toBeNull();
  expect(state.paused?.lastProjectId).not.toBeNull();

  const reports = await openAsLeader(page);
  await idle.set('idle', 'unlocked');
  await expect.poll(() => reports.at(-1)).toEqual({ user: 'idle', screen: 'unlocked' });
  // Nothing was running, so there was nothing to pause and no notice to make.
  expect((await api.state()).awayNotices).toEqual([]);
  expect(await shown(page)).toEqual([]);

  await idle.set('active', 'unlocked');
  await expect.poll(async () => (await shownWithTag(page, 'nothing')).length).toBe(1);
  const [alert] = await shownWithTag(page, 'nothing');
  expect(alert?.title).toBe('Nothing is running');
  expect(alert?.actions).toEqual([{ action: 'resume-project', title: `Resume ${name}` }]);
  expect(await shownWithTag(page, 'away')).toEqual([]);
});

test('Two tabs: only the leader reports to the server and shows the alert', async ({
  page,
  api,
  context,
  idle,
}) => {
  const name = await startProject(api, 'Blog redesign');
  const first = await openAsLeader(page);

  // The second tab takes no part: it is not the leader, so it doesn't run a detector.
  const second = await context.newPage();
  const secondReports = watchPresence(second);
  await second.goto('/');
  await expect(runningBadge(card(second, name))).toBeVisible();

  await idle.set('active', 'locked');
  await expect.poll(async () => (await api.state()).running).toBeNull();
  // Both tabs show the notice, which comes from the server.
  await expect(awayNotice(page)).toContainText(name);
  await expect(awayNotice(second)).toContainText(name);

  await idle.set('active', 'unlocked');
  await expect.poll(async () => (await shownWithTag(page, 'away')).length).toBe(1);
  // The second tab has heard of the return as well, and a moment is enough for an alert, if it
  // were going to raise one.
  await expect.poll(async () => (await api.state()).awayNotices[0]?.returnedAt).not.toBeNull();
  await second.waitForTimeout(1000);

  const alerts = [...(await shownWithTag(page, 'away')), ...(await shownWithTag(second, 'away'))];
  expect(alerts).toHaveLength(1);
  expect(await shown(second)).toEqual([]);

  // One report for each change, all from the leader.
  expect(first).toEqual([
    { user: 'active', screen: 'unlocked' },
    { user: 'active', screen: 'locked' },
    { user: 'active', screen: 'unlocked' },
  ]);
  expect(secondReports).toEqual([]);
});

// Not tested here: the check-in chime, which is due 10 minutes after a Start (tests/unit/presence.test.ts).
