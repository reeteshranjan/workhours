// End-to-end tests for the Active view (DESIGN §10.2–10.5, §14), in Chrome against the built app.
//
// All tests share one server and database (playwright.config.ts), so each test makes projects
// with names of its own, and every test starts by clearing the app through the API: nothing
// running, no away notices, no active projects. Time is set up through the API too (adjust,
// presence reports); the page is what the tests drive and check.
import { expect, test as base } from '@playwright/test';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import type {
  AppState,
  CloseResult,
  ClosedProject,
  ProjectHistory,
  ResetResult,
} from '../../shared/types.js';
import { screenshot, skipSetup } from './helpers.js';

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
    adjust: (id: number, minutes: number, reason: string) =>
      send<AppState>('POST', `/api/projects/${id}/adjust`, { minutes, reason }),
    reset: (id: number) => send<ResetResult>('POST', `/api/projects/${id}/reset`),
    close: (id: number) => send<CloseResult>('POST', `/api/projects/${id}/close`),
    closed: () => send<ClosedProject[]>('GET', '/api/projects/closed'),
    history: (id: number) => send<ProjectHistory>('GET', `/api/projects/${id}/history`),
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

const test = base.extend<{ api: Api }>({
  api: async ({ request }, use) => {
    await use(makeApi(request));
  },
});

test.beforeEach(async ({ api, context }) => {
  await clearApp(api);
  // The welcome dialog is for a first run, and these tests are about the Active view.
  await skipSetup(context);
});

// ---- Page helpers ----

let counter = 0;
/** A project name no other test uses, even though closed projects keep their names. */
function uniqueName(label: string): string {
  counter += 1;
  return `${label} #${counter}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A timer such as 00:10:03. */
const CLOCK = /^\d{2,}:\d{2}:\d{2}$/;

function seconds(clock: string | null): number {
  const [h = 0, m = 0, s = 0] = (clock ?? '').split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  // The add box is drawn once the first state has arrived.
  await expect(page.getByLabel('New project name')).toBeVisible();
}

function card(page: Page, name: string): Locator {
  return page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });
}

function statusBar(page: Page): Locator {
  return page.getByRole('region', { name: 'Status' });
}

function runningBadge(scope: Locator | Page): Locator {
  return scope.getByText('running', { exact: true });
}

/** Moves focus to the page itself, where the keyboard shortcuts apply. */
async function focusPage(page: Page): Promise<void> {
  await page.evaluate(
    'document.activeElement instanceof HTMLElement && document.activeElement.blur()',
  );
}

// ---- Tests ----

// This test must stay first: only the very first Start in a database can be moved back by up to
// 12 hours. A later one can't go before the end of the previous session (DESIGN §5), which in a
// shared database is only moments ago, so the -10 min button would be disabled.
test('Started earlier: the toast opens an editor that moves the start back', async ({
  page,
  api,
}) => {
  const name = uniqueName('Acme Website');
  await api.addProject(name);
  await openApp(page);

  await card(page, name)
    .getByRole('button', { name: `Start ${name}` })
    .click();

  const toast = page.getByRole('status').filter({ hasText: 'Started earlier?' });
  await expect(toast).toContainText(`Started ${name} at`);
  await screenshot(page, 'toast.png');

  await toast.getByRole('button', { name: 'Started earlier?' }).click();
  const time = page.getByLabel('Actually started at');
  await expect(time).toBeVisible();

  // Something that isn't a 24-hour time is refused, and the editor stays open.
  const problem = page.getByText('Enter a 24-hour time such as 14:05.');
  await time.fill('ab');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(problem).toBeVisible();
  await expect(time).toBeVisible();

  // The quick button fills in a 24-hour time and clears the error.
  await page.getByRole('button', { name: /10 min/ }).click();
  await expect(time).toHaveValue(/^([01]\d|2[0-3]):[0-5]\d$/);
  await expect(problem).toHaveCount(0);
  await screenshot(page, 'toast-editor.png');

  // Up and Down step by a minute, so one of each is back where it started.
  const tenBack = await time.inputValue();
  await time.focus();
  await page.keyboard.press('ArrowUp');
  await expect(time).not.toHaveValue(tenBack);
  await page.keyboard.press('ArrowDown');
  await expect(time).toHaveValue(tenBack);
  await page.getByRole('button', { name: 'Save' }).click();

  // At least ten minutes, and less than twelve: the time is moved to a whole minute.
  const current = card(page, name).getByText(CLOCK);
  await expect.poll(async () => seconds(await current.textContent())).toBeGreaterThanOrEqual(600);
  expect(seconds(await current.textContent())).toBeLessThan(12 * 60);
  await expect(time).toBeHidden();
});

test('Add project: duplicates are refused, and a closed name offers Reopen it', async ({
  page,
  api,
}) => {
  const name = uniqueName('Blog redesign');
  await openApp(page);
  const input = page.getByLabel('New project name');

  await input.fill(name);
  await input.press('Enter');
  await expect(card(page, name)).toBeVisible();
  await expect(input).toHaveValue('');

  // The same name in a different case.
  await input.fill(name.toUpperCase());
  await input.press('Enter');
  await expect(page.getByRole('alert')).toHaveText(`${name} already exists.`);
  await expect(card(page, name)).toHaveCount(1);

  // Closed through the API, the name is still taken.
  const id = (await api.state()).projects.find((p) => p.name === name)?.id;
  if (id === undefined) throw new Error('The new project is not in the state');
  await api.close(id);
  await expect(card(page, name)).toHaveCount(0);

  await input.fill(name);
  await input.press('Enter');
  await expect(page.getByRole('alert')).toContainText(`A closed project is called ${name}.`);
  await page.getByRole('button', { name: 'Reopen it' }).click();
  await expect(card(page, name)).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Start, switch and pause', async ({ page, api }) => {
  const a = uniqueName('Alpha');
  const b = uniqueName('Bravo');
  await api.addProject(a);
  await api.addProject(b);
  await openApp(page);
  const status = statusBar(page);

  await card(page, a)
    .getByRole('button', { name: `Start ${a}` })
    .click();
  await expect(runningBadge(card(page, a))).toBeVisible();
  // The first card says what runs, so the status bar has no running line. (These tests allow
  // nothing in Chrome, so the bar may still be there, for its ⚠.)
  await expect(status.getByRole('button', { name: /Pause/ })).toHaveCount(0);
  await expect(status.getByText(a, { exact: true })).toHaveCount(0);
  await expect(status.getByText(CLOCK)).toHaveCount(0);
  // These tests allow nothing in Chrome, so a ⚠ may come first (R11.3): the health check says so
  // a moment after the page loads.
  await expect(page).toHaveTitle(new RegExp(`^(⚠ )?\\d\\d:\\d\\d · ${escapeRegExp(a)}`));

  // Starting B switches: A stops, B runs.
  await card(page, b)
    .getByRole('button', { name: `Start ${b}` })
    .click();
  await expect(runningBadge(card(page, b))).toBeVisible();
  await expect(runningBadge(card(page, a))).toHaveCount(0);
  await expect(status.getByRole('button', { name: /Pause/ })).toHaveCount(0);
  await expect(status.getByText(b, { exact: true })).toHaveCount(0);
  // The running card comes first.
  await expect(page.getByRole('heading', { level: 2 })).toHaveText([b, a]);
  // A stopped by the switch; B is running, so it has no label.
  await expect(card(page, a).getByText(/^paused \d\d:\d\d · switched$/)).toBeVisible();
  await expect(card(page, b).getByText(/^paused /)).toHaveCount(0);

  await card(page, b).getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(status.getByText(/^On break since \d\d:\d\d · \d+m$/)).toBeVisible();
  await expect(card(page, b).getByText(/^paused \d\d:\d\d$/)).toBeVisible();
  // The card paused by the break stays first.
  await expect(page.getByRole('heading', { level: 2 })).toHaveText([b, a]);
  await expect(runningBadge(page)).toHaveCount(0);
  await screenshot(page, 'paused-labels.png');
  await expect(page).toHaveTitle(/^(⚠ )?On break · Work Hours$/);
  const resume = status.getByRole('button', { name: new RegExp(`Resume ${escapeRegExp(b)}$`) });
  await expect(resume).toBeVisible();

  await resume.click();
  await expect(runningBadge(card(page, b))).toBeVisible();
  await expect(runningBadge(card(page, a))).toHaveCount(0);
  await expect(card(page, b).getByText(/^paused /)).toHaveCount(0);
  await expect(card(page, a).getByText(/^paused \d\d:\d\d · switched$/)).toBeVisible();
  await expect(page.getByRole('heading', { level: 2 })).toHaveText([b, a]);

  // On the other views the status bar still has the running line.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(status.getByText(b, { exact: true })).toBeVisible();
  await expect(status.getByRole('button', { name: /Pause/ })).toBeVisible();
  await page.getByRole('button', { name: 'Active', exact: true }).click();
  await expect(card(page, b)).toBeVisible();
});

test('Keyboard shortcuts: 1, Space and N, but not while typing', async ({ page, api }) => {
  const a = uniqueName('Alpha');
  const b = uniqueName('Bravo');
  await api.addProject(a);
  await api.addProject(b);
  await openApp(page);
  await focusPage(page);
  const input = page.getByLabel('New project name');
  await expect(page.getByRole('heading', { level: 2 }).first()).toHaveText(a);

  await page.keyboard.press('1');
  await expect(runningBadge(card(page, a))).toBeVisible();

  await page.keyboard.press('Space');
  await expect(statusBar(page).getByText(/^On break/)).toBeVisible();
  await expect(runningBadge(page)).toHaveCount(0);

  await page.keyboard.press('Space');
  await expect(runningBadge(card(page, a))).toBeVisible();

  await page.keyboard.press('n');
  await expect(input).toBeFocused();

  // In the add box the keys are just text: no project starts and Space doesn't pause.
  await page.keyboard.type('2 n1');
  await expect(input).toHaveValue('2 n1');
  await expect(runningBadge(card(page, a))).toBeVisible();
  await expect(runningBadge(card(page, b))).toHaveCount(0);
});

test('The running card comes first; 1–9 keep the order added', async ({ page, api }) => {
  const a = uniqueName('Alpha');
  const b = uniqueName('Bravo');
  const c = uniqueName('Charlie');
  await api.addProject(a);
  await api.addProject(b);
  await api.addProject(c);
  await openApp(page);
  await focusPage(page);
  const headings = page.getByRole('heading', { level: 2 });
  await expect(headings).toHaveText([a, b, c]);

  await page.keyboard.press('3');
  await expect(runningBadge(card(page, c))).toBeVisible();
  await expect(headings).toHaveText([c, a, b]);
  // The shortcut numbers follow the order added, not the screen.
  await expect(card(page, a).getByRole('button', { name: `Start ${a}` })).toHaveAttribute(
    'title',
    `Start ${a} (1)`,
  );

  await page.keyboard.press('1');
  await expect(runningBadge(card(page, a))).toBeVisible();
  await expect(headings).toHaveText([a, b, c]);

  await page.keyboard.press('2');
  await expect(runningBadge(card(page, b))).toBeVisible();
  await expect(headings).toHaveText([b, a, c]);

  await page.keyboard.press('Space');
  await expect(statusBar(page).getByText(/^On break/)).toBeVisible();
  await expect(headings).toHaveText([b, a, c]);
});

test('Reset dialog shows the hours and minutes to copy, and records them', async ({
  page,
  api,
}) => {
  const name = uniqueName('Data pipeline');
  const id = await api.addProject(name);
  await api.adjust(id, 754, 'seed');
  await openApp(page);
  const project = card(page, name);
  await expect(project.getByText(CLOCK)).toHaveText('12:34:00');

  await project.getByRole('button', { name: 'Reset', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Reset ${name}` });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'hours' })).toHaveValue('12');
  await expect(dialog.getByRole('textbox', { name: 'minutes' })).toHaveValue('34');
  await expect(dialog.getByRole('button', { name: 'Copy' })).toHaveCount(2);
  await screenshot(page, 'reset-dialog.png');

  await dialog.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(dialog.getByText('Recorded')).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'hours' })).toHaveValue('12');
  await expect(dialog.getByRole('textbox', { name: 'minutes' })).toHaveValue('34');
  await screenshot(page, 'reset-done.png');

  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();
  await expect(project.getByText(CLOCK)).toHaveText('00:00:00');

  const resets = (await api.history(id)).entries.filter((entry) => entry.kind === 'reset');
  expect(resets).toHaveLength(1);
  expect(resets[0]?.minutes).toBe(754);
});

test('Reset is disabled under a minute', async ({ page, api }) => {
  const name = uniqueName('Fresh');
  await api.addProject(name);
  await openApp(page);

  await expect(card(page, name).getByRole('button', { name: 'Reset', exact: true })).toBeDisabled();
});

test('Close resets the time left first, shows it to copy, then closes the project', async ({
  page,
  api,
}) => {
  const name = uniqueName('Mobile app audit');
  const id = await api.addProject(name);
  await api.adjust(id, 90, 'seed');
  await openApp(page);
  const project = card(page, name);

  await project.getByRole('button', { name: `More actions for ${name}` }).click();
  await page.getByRole('menuitem', { name: 'Close project' }).click();
  const dialog = page.getByRole('dialog', { name: `Close ${name}` });
  await expect(dialog.getByRole('textbox', { name: 'hours' })).toHaveValue('1');
  await expect(dialog.getByRole('textbox', { name: 'minutes' })).toHaveValue('30');
  await expect(dialog.getByRole('button', { name: 'Copy' })).toHaveCount(2);
  await expect(dialog).toContainText('Closing resets it first, then moves it to Closed projects.');
  await screenshot(page, 'close-dialog.png');

  await dialog.getByRole('button', { name: 'Reset and close' }).click();
  // The project has left the active list, and the dialog stays to show what was reset.
  await expect(dialog.getByText('Recorded and closed')).toBeVisible();
  await expect(project).toHaveCount(0);
  await expect(dialog.getByRole('textbox', { name: 'hours' })).toHaveValue('1');
  await expect(dialog.getByRole('textbox', { name: 'minutes' })).toHaveValue('30');
  await screenshot(page, 'close-done.png');

  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();
  expect((await api.closed()).map((p) => p.name)).toContain(name);
  const resets = (await api.history(id)).entries.filter((entry) => entry.kind === 'reset');
  expect(resets.map((entry) => entry.minutes)).toEqual([90]);
});

test('Close under a minute closes without a reset', async ({ page, api }) => {
  const name = uniqueName('Fresh close');
  const id = await api.addProject(name);
  await openApp(page);
  const project = card(page, name);

  await project.getByRole('button', { name: `More actions for ${name}` }).click();
  await page.getByRole('menuitem', { name: 'Close project' }).click();
  const dialog = page.getByRole('dialog', { name: `Close ${name}` });
  await expect(dialog).toContainText('It moves to Closed projects.');
  await expect(dialog.getByRole('textbox')).toHaveCount(0);

  await dialog.getByRole('button', { name: 'Close project' }).click();
  await expect(dialog).toBeHidden();
  await expect(project).toHaveCount(0);
  expect((await api.history(id)).entries).toEqual([]);
});

test.describe('Away notice in the status bar', () => {
  /** The pending automatic pauses in the status bar. Its warning line has role=status too. */
  function notices(page: Page): Locator {
    return statusBar(page).getByRole('status').filter({ hasText: 'auto-paused' });
  }

  /** A running project whose screen locked and unlocked again, with the page open. */
  async function awayFromProject(page: Page, api: Api): Promise<{ name: string; notice: Locator }> {
    const name = uniqueName('Acme Website');
    await api.start(await api.addProject(name));
    await openApp(page);
    await expect(runningBadge(card(page, name))).toBeVisible();

    await api.presence('active', 'locked');
    await api.presence('active', 'unlocked');
    const notice = notices(page);
    await expect(notice).toContainText(name);
    await expect(notice).toContainText(/auto-paused \d\d:\d\d\s*·\s*screen locked/);
    await expect(runningBadge(page)).toHaveCount(0);
    await expect(card(page, name).getByText(/auto-paused \d\d:\d\d · screen locked/)).toBeVisible();
    // One box, no banner under it: the status bar and the card are the only places that say why.
    await expect(statusBar(page).getByText('screen locked')).toHaveCount(1);
    await expect(card(page, name).getByText('screen locked')).toHaveCount(1);
    await expect(page.getByText('screen locked')).toHaveCount(2);
    return { name, notice };
  }

  test('Count the time away keeps the project running', async ({ page, api }) => {
    const { name, notice } = await awayFromProject(page, api);
    await screenshot(page, 'status-notice.png');

    await notice.getByRole('button', { name: /^Count the \d+m$/ }).click();
    await expect(notice).toHaveCount(0);
    await expect(runningBadge(card(page, name))).toBeVisible();
  });

  test('Resume starts the project again now', async ({ page, api }) => {
    const { name, notice } = await awayFromProject(page, api);

    await notice.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(notice).toHaveCount(0);
    await expect(runningBadge(card(page, name))).toBeVisible();
    await expect(card(page, name).getByText(/auto-paused/)).toHaveCount(0);
  });

  test('Dismiss leaves nothing running', async ({ page, api }) => {
    const { name, notice } = await awayFromProject(page, api);

    await notice.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect(notice).toHaveCount(0);
    await expect(runningBadge(page)).toHaveCount(0);
    await expect(
      statusBar(page).getByText(/^Auto-paused since \d\d:\d\d · screen locked · \d+m$/),
    ).toBeVisible();
    await expect(card(page, name).getByText(/auto-paused \d\d:\d\d · screen locked/)).toBeVisible();
    await screenshot(page, 'auto-paused-label.png');
  });

  test('Start on the card is Resume', async ({ page, api }) => {
    const { name, notice } = await awayFromProject(page, api);

    await card(page, name)
      .getByRole('button', { name: `Start ${name}` })
      .click();
    await expect(notice).toHaveCount(0);
    await expect(runningBadge(card(page, name))).toBeVisible();
    await expect(card(page, name).getByText(/auto-paused/)).toHaveCount(0);
    expect((await api.state()).awayNotices).toEqual([]);
  });

  test('Another project started with a notice pending: its row has Count and Dismiss, no Resume', async ({
    page,
    api,
  }) => {
    const { name: nameA } = await awayFromProject(page, api);
    const nameB = uniqueName('Beta Portal');
    const idB = await api.addProject(nameB);
    await card(page, nameB)
      .getByRole('button', { name: `Start ${nameB}` })
      .click();

    const bar = statusBar(page);
    await expect(runningBadge(card(page, nameB))).toBeVisible();
    // The running line is not in the bar: B's card comes first and says the same.
    await expect(bar.getByText(nameB)).toHaveCount(0);
    await expect(bar.getByRole('button', { name: /Pause/ })).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 2 }).first()).toHaveText(nameB);

    // A's pause is still pending, as a row of its own.
    const row = notices(page);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(nameA);
    await expect(row.getByRole('button', { name: /^Count the \d+m$/ })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Dismiss', exact: true })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Resume' })).toHaveCount(0);
    await screenshot(page, 'status-notice-row.png');

    // Count ends A's time away where B started, and B keeps running.
    const before = await api.state();
    const pending = before.awayNotices.find((n) => n.projectName === nameA);
    const startedB = before.running?.startedAt ?? Number.NaN;
    expect(before.running?.projectId).toBe(idB);
    expect(pending?.nextStartedAt).toBe(startedB);

    await row.getByRole('button', { name: /^Count the \d+m$/ }).click();
    await expect(row).toHaveCount(0);
    await expect(runningBadge(card(page, nameB))).toBeVisible();

    const after = await api.state();
    expect(after.running?.projectId).toBe(idB);
    expect(after.awayNotices).toEqual([]);
    const projectA = after.projects.find((p) => p.name === nameA);
    expect(projectA?.lastPause).toEqual({ at: startedB, reason: 'switch' });
  });
});

test('Dark mode renders the Active view', async ({ page, api }) => {
  const name = uniqueName('Acme Website');
  await api.start(await api.addProject(name));
  await page.emulateMedia({ colorScheme: 'dark' });
  await openApp(page);

  await expect(runningBadge(card(page, name))).toBeVisible();
  // The dark theme's page background (--bg in app.css).
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(14, 16, 19)');
  await screenshot(page, 'dark.png');
});
