// End-to-end tests for adjusting time, the History view and the Closed view (R3.5, R4, R5.3,
// R5.4; DESIGN §10.2, §10.5, §10.6), in Chrome against the built app.
//
// The tests share one server and database (playwright.config.ts), like active.spec.ts: each uses
// project names of its own, and each starts by closing every active project through the API.
// Seeding (adjustments, resets, closing) goes through the API too; the page is what the tests drive.
import { expect, test as base } from '@playwright/test';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import type { AppState, CloseResult, ProjectHistory, ResetResult } from '../../shared/types.js';
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
    return (await response.json()) as T;
  }

  return {
    state: () => send<AppState>('GET', '/api/state'),
    async addProject(name: string): Promise<number> {
      const state = await send<AppState>('POST', '/api/projects', { name });
      const project = state.projects.find((p) => p.name === name);
      if (!project) throw new Error(`"${name}" is not in the state after adding it`);
      return project.id;
    },
    pause: () => send<AppState>('POST', '/api/pause'),
    adjust: (id: number, minutes: number, reason: string) =>
      send<AppState>('POST', `/api/projects/${id}/adjust`, { minutes, reason }),
    reset: (id: number) => send<ResetResult>('POST', `/api/projects/${id}/reset`),
    close: (id: number) => send<CloseResult>('POST', `/api/projects/${id}/close`),
    history: (id: number) => send<ProjectHistory>('GET', `/api/projects/${id}/history`),
  };
}

type Api = ReturnType<typeof makeApi>;

/** Nothing running and no active projects. */
async function clearApp(api: Api): Promise<void> {
  const state = await api.state();
  if (state.running) await api.pause();
  for (const project of state.projects) await api.close(project.id);
}

const test = base.extend<{ api: Api }>({
  api: async ({ request }, use) => {
    await use(makeApi(request));
  },
});

test.beforeEach(async ({ api, context }) => {
  await clearApp(api);
  // The welcome dialog is for a first run, and these tests are about managing projects.
  await skipSetup(context);
});

// ---- Page helpers ----

let counter = 0;
/** A project name no other test uses, even though closed projects keep their names. */
function uniqueName(label: string): string {
  counter += 1;
  return `${label} #${counter}`;
}

/** A timer such as 00:10:03. */
const CLOCK = /^\d{2,}:\d{2}:\d{2}$/;

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

/** Opens the card's ⋯ menu and picks an item. */
async function chooseFromMenu(page: Page, name: string, item: string): Promise<void> {
  await card(page, name)
    .getByRole('button', { name: `More actions for ${name}` })
    .click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

/** Opens the Adjust time dialog, and enters a direction, minutes and a reason (not saved yet). */
async function fillAdjustment(
  page: Page,
  name: string,
  direction: '+ Add' | '− Remove',
  minutes: number,
  reason?: string,
): Promise<Locator> {
  await chooseFromMenu(page, name, 'Adjust time');
  const dialog = page.getByRole('dialog', { name: `Adjust ${name}` });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: direction, exact: true }).click();
  await dialog.getByLabel('Minutes').fill(String(minutes));
  if (reason !== undefined) await dialog.getByLabel('Reason').fill(reason);
  return dialog;
}

// ---- Tests ----

test('Adjust time adds minutes, and removing more than Current is refused (R4)', async ({
  page,
  api,
}) => {
  const name = uniqueName('Adjust me');
  await api.addProject(name);
  await openApp(page);
  const current = card(page, name).getByText(CLOCK);
  await expect(current).toHaveText('00:00:00');

  // The menu lists Adjust time, History and Close project, in that order.
  await card(page, name)
    .getByRole('button', { name: `More actions for ${name}` })
    .click();
  await expect(page.getByRole('menuitem')).toHaveText(['Adjust time', 'History', 'Close project']);
  await page.keyboard.press('Escape');

  // Add 30 minutes.
  let dialog = await fillAdjustment(page, name, '+ Add', 30, 'worked offline on the train');
  await expect(dialog.getByRole('button', { name: '+ Add', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(dialog).toContainText('Current will be 00:30:00');
  await screenshot(page, 'adjust-dialog.png');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(current).toHaveText('00:30:00');

  // Removing 40 would go below zero: the dialog says so and Save is off.
  dialog = await fillAdjustment(page, name, '− Remove', 40, 'a mistake');
  await expect(dialog).toContainText(
    "Can't remove more than 30m: time already reset has been billed.",
  );
  await expect(dialog.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await screenshot(page, 'adjust-limit.png');

  // Removing 10 is fine.
  await dialog.getByLabel('Minutes').fill('10');
  await expect(dialog).toContainText('Current will be 00:20:00');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(current).toHaveText('00:20:00');
});

test('Adjust time needs a reason, and Cancel changes nothing', async ({ page, api }) => {
  const name = uniqueName('Needs a reason');
  const id = await api.addProject(name);
  await openApp(page);

  const dialog = await fillAdjustment(page, name, '+ Add', 15);
  const save = dialog.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeDisabled();
  await dialog.getByLabel('Reason').fill('   ');
  await expect(save).toBeDisabled();
  await dialog.getByLabel('Reason').fill('a call that ran over');
  await expect(save).toBeEnabled();

  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(card(page, name).getByText(CLOCK)).toHaveText('00:00:00');
  expect((await api.history(id)).entries).toHaveLength(0);
});

test('History lists resets and adjustments, newest first', async ({ page, api }) => {
  const name = uniqueName('Data pipeline');
  const id = await api.addProject(name);
  await api.adjust(id, 754, 'catch-up from last week');
  await api.reset(id);
  await api.adjust(id, 30, 'worked offline on the train');
  await openApp(page);

  await chooseFromMenu(page, name, 'History');
  const dialog = page.getByRole('dialog', { name: `History · ${name}` });
  const entries = dialog.getByRole('listitem');
  await expect(entries).toHaveCount(3);
  await expect(entries.nth(0)).toContainText('+30 min');
  await expect(entries.nth(0)).toContainText('worked offline on the train');
  await expect(entries.nth(1)).toContainText('Reset 12 h 34 min');
  await expect(entries.nth(2)).toContainText('+754 min');
  await expect(entries.nth(2)).toContainText('catch-up from last week');
  await expect(entries.nth(0)).toContainText(/^\d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}\s*·/);
  await screenshot(page, 'history-dialog.png');

  // A new adjustment shows up while the dialog is open, and a removal has a real minus sign.
  await api.adjust(id, -5, 'rounded down');
  await expect(entries).toHaveCount(4);
  await expect(entries.nth(0)).toContainText('−5 min');

  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
});

test('History of a new project is empty', async ({ page, api }) => {
  const name = uniqueName('Brand new');
  await api.addProject(name);
  await openApp(page);

  await chooseFromMenu(page, name, 'History');
  const dialog = page.getByRole('dialog', { name: `History · ${name}` });
  await expect(dialog.getByText('No resets or adjustments yet.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
});

test('Closed view lists closed projects with their history, and Reopen brings one back', async ({
  page,
  api,
}) => {
  const first = uniqueName('Blog redesign');
  const second = uniqueName('Mobile app audit');
  const firstId = await api.addProject(first);
  await api.addProject(second);
  // 12h 34m was reset, then 1h 30m was added, which closing reset (R5.1): 14h 04m in total.
  await api.adjust(firstId, 754, 'catch-up from last week');
  await api.reset(firstId);
  await api.adjust(firstId, 90, 'late entry');
  await api.close(firstId);
  await openApp(page);
  await expect(card(page, first)).toHaveCount(0);

  await page.getByRole('button', { name: 'Closed', exact: true }).click();
  const row = page
    .getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name: first }) });
  await expect(row).toBeVisible();
  await expect(row).toContainText(/closed \d{2} [A-Z][a-z]{2} \d{4}/);
  await expect(row).toContainText('14h 04m');
  // Rows start collapsed.
  const toggle = row.getByRole('button', { name: `History of ${first}` });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(row.getByRole('button', { name: 'Reopen' })).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(row).toContainText('Reset 12 h 34 min');
  await expect(row).toContainText('late entry');
  await expect(row).toContainText('Reset 1 h 30 min');
  await screenshot(page, 'closed-view.png');

  // Reopen: the project leaves the Closed list and is back in Active, in its original place.
  await row.getByRole('button', { name: 'Reopen' }).click();
  await expect(row).toHaveCount(0);
  await page.getByRole('button', { name: 'Active', exact: true }).click();
  await expect(page.getByRole('heading', { level: 2 })).toHaveText([first, second]);
  await expect(card(page, first).getByText(CLOCK)).toHaveText('00:00:00');
  await expect(card(page, first).getByText('14h 04m total')).toBeVisible();
});

test('Closed view says so when there are no closed projects', async ({ page }) => {
  // Earlier tests leave closed projects in the shared database, so the list is answered here.
  await page.route('**/api/projects/closed', (route) => route.fulfill({ json: [] }));
  await openApp(page);

  await page.getByRole('button', { name: 'Closed', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Closed projects' })).toBeVisible();
  await expect(page.getByText('No closed projects.')).toBeVisible();
});
