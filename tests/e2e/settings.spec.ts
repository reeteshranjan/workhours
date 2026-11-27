// End-to-end tests for the Settings view (R7.6, R7.7, R8.4, R9.3; DESIGN §10.7), in Chrome against
// the built app.
//
// The tests share one server and database (playwright.config.ts), so each puts the settings back
// to the defaults when it is done. What can't be checked here is how the sounds and the
// notification look and sound on the user's computer.
import { expect, test as base } from '@playwright/test';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { DEFAULT_SETTINGS, MIN_VOLUME } from '../../shared/types.js';
import type { Settings } from '../../shared/types.js';
import { screenshot, skipSetup } from './helpers.js';

// ---- API helper ----

function makeApi(request: APIRequestContext) {
  return {
    async settings(): Promise<Settings> {
      const response = await request.get('/api/settings');
      expect(response.ok()).toBe(true);
      return (await response.json()) as Settings;
    },
    async putSettings(settings: Settings): Promise<void> {
      const response = await request.put('/api/settings', { data: settings });
      expect(response.ok(), await response.text()).toBe(true);
    },
  };
}

const test = base.extend<{ api: ReturnType<typeof makeApi> }>({
  api: async ({ request }, use) => {
    const api = makeApi(request);
    await use(api);
    await api.putSettings(DEFAULT_SETTINGS);
  },
});

test.beforeEach(async ({ api, context }) => {
  await api.putSettings(DEFAULT_SETTINGS);
  // The welcome dialog is for a first run, and these tests are about Settings.
  await skipSetup(context);
});

// ---- Page helpers ----

/** Opens the app on the Settings view. */
async function openSettings(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings', level: 2 })).toBeVisible();
}

function volumeSlider(page: Page): Locator {
  return page.getByRole('slider', { name: 'Volume' });
}

/** The alerts card's row for one check, such as "Notifications". */
function checkRow(page: Page, label: string): Locator {
  return page
    .getByRole('region', { name: 'Alerts' })
    .getByRole('listitem')
    .filter({ hasText: label });
}

/** The slider's value, as a number. */
async function sliderValue(slider: Locator): Promise<number> {
  return Number(await slider.inputValue());
}

/**
 * Records every notification the page asks the service worker to show, in `window.shown`. The
 * test browser has no notification centre to look in.
 */
const RECORD_NOTIFICATIONS = `(() => {
  window.shown = [];
  const show = ServiceWorkerRegistration.prototype.showNotification;
  ServiceWorkerRegistration.prototype.showNotification = function (title, options) {
    window.shown.push({ title, ...options });
    return show.call(this, title, options);
  };
})();`;

/** Counts the notes the page plays (each is an oscillator), in `window.notes`. */
const COUNT_NOTES = `(() => {
  window.notes = 0;
  const create = AudioContext.prototype.createOscillator;
  AudioContext.prototype.createOscillator = function () {
    window.notes += 1;
    return create.call(this);
  };
})();`;

// ---- Tests ----

test('The Settings button is a gear icon with an accessible name', async ({ page }) => {
  await page.goto('/');
  const button = page.getByRole('button', { name: 'Settings', exact: true });
  await expect(button.locator('svg')).toBeVisible();
  await expect(button).not.toContainText('⚙');
  // Large enough to read next to the text buttons.
  const box = await button.locator('svg').boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(16);
  expect(box?.height).toBeGreaterThanOrEqual(16);

  await button.click();
  await expect(button).toHaveAttribute('aria-current', 'page');
});

test('Check-in interval: 5, 10 or 15 minutes, saved, and still chosen after a reload', async ({
  page,
  api,
}) => {
  await openSettings(page);
  const radios = page.getByRole('radio');
  await expect(radios).toHaveCount(3);
  await expect(page.getByRole('radio', { name: '10 minutes', exact: true })).toBeChecked();
  // There is no "off" (R7.7).
  await expect(page.getByRole('radio', { name: /off/i })).toHaveCount(0);

  await page.getByRole('radio', { name: '15 minutes', exact: true }).check();
  await expect.poll(async () => (await api.settings()).checkinMinutes).toBe(15);
  await expect(page.getByRole('radio', { name: '15 minutes', exact: true })).toBeChecked();

  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('radio', { name: '15 minutes', exact: true })).toBeChecked();
  await expect(page.getByRole('radio', { name: '10 minutes', exact: true })).not.toBeChecked();

  await page.getByRole('radio', { name: '5 minutes', exact: true }).check();
  await expect.poll(async () => (await api.settings()).checkinMinutes).toBe(5);
});

test('Volume: the slider stops at the minimum, and the minimum is saved', async ({ page, api }) => {
  await openSettings(page);
  const slider = volumeSlider(page);
  await expect(slider).toHaveAttribute('min', String(MIN_VOLUME));
  await expect(slider).toHaveAttribute('max', '1');
  expect(await sliderValue(slider)).toBeCloseTo(DEFAULT_SETTINGS.volume);
  await expect(page.getByText('Sounds can be lowered but not turned off.')).toBeVisible();

  // The other end first, so the move to the minimum is a change.
  await slider.focus();
  await page.keyboard.press('End');
  await expect.poll(async () => (await api.settings()).volume).toBe(1);

  await page.keyboard.press('Home');
  await expect.poll(async () => (await api.settings()).volume).toBe(MIN_VOLUME);
  expect(await sliderValue(slider)).toBe(MIN_VOLUME);
  await expect(page.getByText('20%')).toBeVisible();

  // Several steps in a row (as when a key is held): the slider ends where the last one put it.
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await api.settings()).volume).toBeCloseTo(0.35);
  await expect.poll(() => sliderValue(slider)).toBeCloseTo(0.35);
  await page.keyboard.press('Home');
  await expect.poll(async () => (await api.settings()).volume).toBe(MIN_VOLUME);

  // Further down is not possible, by key or by script.
  await page.keyboard.press('ArrowLeft');
  expect(await sliderValue(slider)).toBe(MIN_VOLUME);
  // (As strings: these files have no DOM types.)
  await slider.evaluate(`(el) => {
    el.value = '0';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }`);
  expect(await sliderValue(slider)).toBe(MIN_VOLUME);
  expect((await api.settings()).volume).toBe(MIN_VOLUME);

  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  expect(await sliderValue(volumeSlider(page))).toBe(MIN_VOLUME);
});

test('The play buttons play the chime (two notes) and the alert tone (three)', async ({ page }) => {
  await page.addInitScript(COUNT_NOTES);
  await openSettings(page);

  await page.getByRole('button', { name: 'Play chime' }).click();
  await expect.poll(() => page.evaluate('window.notes')).toBe(2);
  // They are clicks, so they turn sound on if it wasn't.
  await expect(checkRow(page, 'Sound')).toContainText('✓');
  await expect(checkRow(page, 'Sound')).toContainText('Sound is on.');

  await page.getByRole('button', { name: 'Play alert tone' }).click();
  await expect.poll(() => page.evaluate('window.notes')).toBe(5);
});

test('Data: the folder, Copy, the backup note, and the two exports', async ({
  page,
  context,
  request,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openSettings(page);

  const folder = page.getByTestId('data-dir');
  await expect(folder).toHaveText(/\.e2e-data$/);
  const dataDir = (await folder.textContent()) ?? '';
  expect(dataDir.startsWith('/')).toBe(true);
  await expect(page.getByText('A backup is made every day in')).toContainText(
    `${dataDir}/backups; the last 14 are kept.`,
  );

  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate('navigator.clipboard.readText()')).toBe(dataDir);

  const json = page.getByRole('link', { name: 'Export JSON' });
  await expect(json).toHaveAttribute('href', '/api/export?format=json');
  await expect(json).toHaveAttribute('download', '');

  const csv = page.getByRole('link', { name: 'Export CSV' });
  await expect(csv).toHaveAttribute('href', '/api/export?format=csv');
  await expect(csv).toHaveAttribute('download', '');
  const response = await request.get((await csv.getAttribute('href')) ?? '');
  expect(response.ok()).toBe(true);
  expect(await response.text()).toMatch(/^project,date,hours,minutes\n/);

  const jsonResponse = await request.get((await json.getAttribute('href')) ?? '');
  expect(jsonResponse.ok()).toBe(true);
  expect(Object.keys((await jsonResponse.json()) as object)).toContain('projects');

  // The version line is the server's own.
  const health = (await (await request.get('/api/health')).json()) as {
    version: string;
    dataDir: string;
  };
  expect(health.dataDir).toBe(dataDir);
  await expect(page.getByText(`Work Hours ${health.version}`, { exact: true })).toBeVisible();
});

test('Alerts: each check is ✓ or ⚠ with its warning, and notifications turn ✓ when allowed', async ({
  page,
  context,
}) => {
  await openSettings(page);
  const checks = page.getByRole('region', { name: 'Alerts' }).getByRole('listitem');
  await expect(checks).toHaveCount(5);
  await expect(checks).toContainText([
    'Server',
    'Sound',
    'Notifications',
    'Away detection',
    'Tab kept active',
  ]);

  // Nothing is allowed yet. The server and the tab are fine.
  await expect(checkRow(page, 'Server')).toContainText('✓');
  await expect(checkRow(page, 'Tab kept active')).toContainText('✓');
  await expect(checkRow(page, 'Notifications')).toContainText('⚠');
  await expect(checkRow(page, 'Notifications')).toContainText(
    "Notifications are off. Alerts can't reach you in the background.",
  );
  await expect(checkRow(page, 'Away detection')).toContainText('⚠');

  // Chrome remembers the permission for the next page load.
  await context.grantPermissions(['notifications']);
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(checkRow(page, 'Notifications')).toContainText('✓');
  await expect(checkRow(page, 'Notifications')).not.toContainText('⚠');
  await expect(checkRow(page, 'Notifications')).toContainText('Notifications are allowed.');
});

test('Set up alerts reopens the setup dialog at step 1', async ({ page }) => {
  await openSettings(page);
  await page.getByRole('button', { name: 'Set up alerts' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Step 1 of 4')).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Sound' })).toBeVisible();

  await dialog.getByRole('button', { name: 'Skip' }).click();
  await expect(dialog.getByText('Step 2 of 4')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  // Back on Settings.
  await expect(page.getByRole('heading', { name: 'Settings', level: 2 })).toBeVisible();
});

test('Send test alert plays the tone and shows a notification', async ({ page, context }) => {
  await context.grantPermissions(['notifications']);
  await page.addInitScript(RECORD_NOTIFICATIONS);
  await openSettings(page);

  await page.getByRole('button', { name: 'Send test alert' }).click();
  await expect(page.getByText('Test alert sent.')).toBeVisible();
  // The click turned sound on, too.
  await expect(checkRow(page, 'Sound')).toContainText('✓');
  expect(await page.evaluate('window.shown')).toEqual([
    expect.objectContaining({
      title: 'Work Hours test alert',
      body: 'Alerts are working.',
      tag: 'test',
      requireInteraction: true,
    }),
  ]);
});

test('Send test alert without notification permission says only the sound played', async ({
  page,
}) => {
  await openSettings(page);
  await page.getByRole('button', { name: 'Send test alert' }).click();
  await expect(page.getByText('Notifications are off, so only the sound played.')).toBeVisible();
});

test('Settings look right in light and dark', async ({ page, context }) => {
  // Tall enough for the whole view.
  await page.setViewportSize({ width: 900, height: 1200 });
  await context.grantPermissions(['notifications']);
  await openSettings(page);
  // Sound on, notifications allowed, away detection off: both kinds of row show.
  await page.getByRole('button', { name: 'Play chime' }).click();
  await expect(checkRow(page, 'Sound')).toContainText('✓');
  await expect(checkRow(page, 'Notifications')).toContainText('✓');
  await expect(checkRow(page, 'Away detection')).toContainText('⚠');
  await expect(page.getByTestId('data-dir')).toBeVisible();
  await screenshot(page, 'settings.png');

  await page.emulateMedia({ colorScheme: 'dark' });
  // The buttons fade to their dark colours; the picture is taken once they have.
  await expect(page.getByRole('button', { name: 'Set up alerts' })).toHaveCSS(
    'background-color',
    'rgb(22, 25, 30)',
  );
  await screenshot(page, 'settings-dark.png');
});
