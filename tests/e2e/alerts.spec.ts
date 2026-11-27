// End-to-end tests for the setup dialog, the health warnings (including the "Sound is off" one that
// unlocks sound) and the unsupported-browser page (DESIGN §8), in Chrome against the built app.
//
// Each test gets a fresh browser context, so it starts with no localStorage: a first run. What
// can't be checked here is how a real notification looks and sounds on the user's computer.
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { screenshot, skipSetup } from './helpers.js';

const WELCOME = 'Work Hours keeps your time log accurate';
const SOUND_WARNING = 'Sound is off. Click to turn on.';
const NOTIFICATIONS_WARNING = "Notifications are off. Alerts can't reach you in the background.";
const AWAY_WARNING = "Away detection is off. The timer won't pause when you leave.";

function dialog(page: Page): Locator {
  return page.getByRole('dialog');
}

function statusBar(page: Page): Locator {
  return page.getByRole('region', { name: 'Status' });
}

/**
 * The warning line in the status bar (the first warning, and "+N more"). A pending automatic pause
 * in the status bar has role=status too, so this picks the line that starts with the ⚠.
 */
function warningLine(page: Page): Locator {
  return statusBar(page).getByRole('status').filter({ hasText: '⚠' });
}

/** The "Sound is off. Click to turn on." button in the status bar's warning line. */
function soundWarningButton(page: Page): Locator {
  return warningLine(page).getByRole('button', { name: /Sound is off/ });
}

/** Opens the app and waits for the first state, which draws the status bar. */
async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(statusBar(page)).toBeVisible();
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

/** The flag is set when the dialog's close event runs, a moment after the dialog is gone. */
async function expectSetupFlag(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate("localStorage.getItem('workhours:setup-complete')"))
    .toBe('1');
}

test('First run: the welcome dialog leads through four steps, and Skip on each closes it', async ({
  page,
}) => {
  await page.goto('/');
  const setup = dialog(page);
  await expect(setup.getByRole('heading', { name: WELCOME })).toBeVisible();
  await expect(setup).toContainText('When you step away, the running timer pauses');
  await expect(setup).toContainText('While a timer runs, a soft chime plays every 10 minutes.');
  await expect(setup).toContainText(
    "Work Hours needs sound, notifications, and permission to notice when you're away from your computer.",
  );
  await expect(setup.getByText(/Step \d of 4/)).toHaveCount(0);
  await screenshot(page, 'welcome.png');

  await setup.getByRole('button', { name: 'Set up alerts' }).click();
  await expect(setup.getByText('Step 1 of 4')).toBeVisible();
  await expect(setup.getByRole('heading', { name: 'Sound' })).toBeVisible();
  await expect(setup).toContainText("You'll hear the soft check-in chime, then the alert tone.");
  await setup.getByRole('button', { name: 'Skip' }).click();

  await expect(setup.getByText('Step 2 of 4')).toBeVisible();
  await expect(setup.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  await screenshot(page, 'setup-step-2.png');
  await setup.getByRole('button', { name: 'Skip' }).click();

  await expect(setup.getByText('Step 3 of 4')).toBeVisible();
  await expect(setup).toContainText(
    "It only learns whether you're active and whether the screen is locked.",
  );
  await setup.getByRole('button', { name: 'Skip' }).click();

  await expect(setup.getByText('Step 4 of 4')).toBeVisible();
  await expect(setup.getByRole('heading', { name: 'Keep this tab active' })).toBeVisible();
  await expect(setup.locator('code', { hasText: 'chrome://settings/performance' })).toBeVisible();
  await expect(setup.locator('code', { hasText: 'localhost:7498' })).toBeVisible();
  await screenshot(page, 'setup-step-4.png');
  await setup.getByRole('button', { name: 'Skip' }).click();

  await expect(setup).toHaveCount(0);
  await expectSetupFlag(page);

  // A reload: no welcome dialog. Nothing was allowed, so the status bar warns, and so does the tab.
  await page.reload();
  await expect(statusBar(page)).toBeVisible();
  await expect(setup).toHaveCount(0);
  await expect(warningLine(page)).toContainText(SOUND_WARNING);
  await expect(warningLine(page)).toContainText('+2 more');
  await expect(page).toHaveTitle(/^⚠ /);
  await screenshot(page, 'warning.png');
});

test('Closing the dialog with Esc counts as having seen it', async ({ page }) => {
  await page.goto('/');
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expectSetupFlag(page);
});

test('Every step with notifications allowed: sound, a test notification, away, keep active', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['notifications', 'clipboard-read', 'clipboard-write']);
  await page.addInitScript(RECORD_NOTIFICATIONS);
  await page.goto('/');
  const setup = dialog(page);
  await setup.getByRole('button', { name: 'Set up alerts' }).click();

  // 1. Sound: both sounds play (about a second and a half), then there is a ✓ and Next.
  await setup.getByRole('button', { name: 'Turn on sound' }).click();
  await expect(setup.getByText('✓ Sound is on.')).toBeVisible();
  await setup.getByRole('button', { name: 'Next' }).click();

  // 2. Notifications: the test notification is sent, and the dialog asks about it.
  await setup.getByRole('button', { name: 'Allow notifications' }).click();
  await expect(setup.getByText('Did it stay on screen until you clicked it?')).toBeVisible();
  // The notification asked for stays until clicked.
  expect(await page.evaluate('window.shown')).toEqual([
    expect.objectContaining({
      title: 'Work Hours notifications work',
      body: 'Did this stay on screen until you clicked it?',
      tag: 'test',
      requireInteraction: true,
    }),
  ]);
  await screenshot(page, 'setup-step-2-question.png');
  await setup.getByRole('button', { name: 'No' }).click();
  await expect(setup.getByText('System Settings → Notifications → Google Chrome')).toBeVisible();
  await expect(setup).toContainText('Persistent');
  await screenshot(page, 'setup-step-2-help.png');
  await setup.getByRole('button', { name: 'Next' }).click();

  // 3. Away detection: the permission prompt is Chrome's, which a test can't answer. Whatever
  // Chrome says, the dialog says something and offers Next.
  await expect(setup.getByText('Step 3 of 4')).toBeVisible();
  await setup.getByRole('button', { name: 'Allow away detection' }).click();
  await expect(setup.getByRole('status')).toBeVisible();
  await screenshot(page, 'setup-step-3.png');
  await setup.getByRole('button', { name: 'Next' }).click();

  // 4. Keep this tab active: the copy buttons put the address and the settings link on the clipboard.
  await expect(setup.getByText('Step 4 of 4')).toBeVisible();
  await setup.getByRole('button', { name: 'Copy address' }).click();
  await expect(setup.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate('navigator.clipboard.readText()')).toBe('localhost:7498');
  await setup.getByRole('button', { name: 'Copy settings link' }).click();
  expect(await page.evaluate('navigator.clipboard.readText()')).toBe(
    'chrome://settings/performance',
  );
  await setup.getByRole('button', { name: 'Done' }).click();

  await expect(setup).toHaveCount(0);
  await expectSetupFlag(page);
  // The sound step's click unlocked sound, and the notification permission is granted.
  await expect(statusBar(page)).toBeVisible();
  await expect(warningLine(page)).not.toContainText(SOUND_WARNING);
  await expect(warningLine(page)).not.toContainText(NOTIFICATIONS_WARNING);
});

test('A refused notification permission explains how to allow it again', async ({ page }) => {
  // The test browser answers Chrome's prompt with "blocked", the same as a user who clicks Block.
  await page.goto('/');
  const setup = dialog(page);
  await setup.getByRole('button', { name: 'Set up alerts' }).click();
  await setup.getByRole('button', { name: 'Skip' }).click();
  await setup.getByRole('button', { name: 'Allow notifications' }).click();
  await expect(setup.getByRole('status')).toContainText('Site settings → Notifications → Allow');
  await expect(setup.getByRole('button', { name: 'Next' })).toBeVisible();
});

test.describe('Setup is done', () => {
  test.beforeEach(async ({ context }) => {
    await skipSetup(context);
  });

  test('The Sound is off warning unlocks sound with one click', async ({ page }) => {
    await openApp(page);
    await expect(dialog(page)).toHaveCount(0);
    await expect(warningLine(page)).toContainText(SOUND_WARNING);
    // The status bar's warning is the only prompt: there is no separate "resume alerts" box.
    await expect(page.getByText('Click to resume alerts')).toHaveCount(0);
    await screenshot(page, 'sound-off.png');

    await soundWarningButton(page).click();
    await expect(soundWarningButton(page)).toHaveCount(0);
    await expect(warningLine(page)).not.toContainText(SOUND_WARNING);
    // Notifications and away detection are still off, so the tab title still warns.
    await expect(warningLine(page)).toContainText('Notifications are off');
    await expect(page).toHaveTitle(/^⚠ /);
  });

  test('A click anywhere on the page unlocks sound too', async ({ page }) => {
    await openApp(page);
    await expect(warningLine(page)).toContainText(SOUND_WARNING);

    await page.getByRole('heading', { name: 'Work Hours', level: 1 }).click();
    await expect(warningLine(page)).not.toContainText(SOUND_WARNING);
  });

  test('With notifications allowed there is no notifications warning', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['notifications']);
    await openApp(page);

    // Sound first, then (in the tooltip) away detection: nothing about notifications.
    await expect(warningLine(page)).toContainText(SOUND_WARNING);
    await expect(warningLine(page)).toContainText('+1 more');
    const more = warningLine(page).getByText('+1 more');
    await expect(more).toHaveAttribute('title', `${SOUND_WARNING}\n${AWAY_WARNING}`);

    await soundWarningButton(page).click();
    await expect(warningLine(page)).toContainText(AWAY_WARNING);
    await expect(warningLine(page)).not.toContainText('more');
    await expect(statusBar(page)).not.toContainText('Notifications are off');
  });

  test('Clicking the notifications warning reopens setup at that step', async ({ page }) => {
    await openApp(page);
    await soundWarningButton(page).click();
    await expect(warningLine(page)).toContainText('Notifications are off');

    await warningLine(page)
      .getByRole('button', { name: /Notifications are off/ })
      .click();
    await expect(dialog(page).getByText('Step 2 of 4')).toBeVisible();
    await expect(dialog(page).getByRole('button', { name: 'Allow notifications' })).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Skip' }).click();
    await expect(dialog(page).getByText('Step 3 of 4')).toBeVisible();
  });
});

test('Unsupported browser: the page says Work Hours needs Google Chrome', async ({ page }) => {
  await page.addInitScript('delete window.IdleDetector;');
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Work Hours needs Google Chrome' })).toBeVisible();
  await expect(page.getByText('Open this address in Chrome:')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Address to open in Chrome' })).toHaveValue(
    'http://localhost:7498',
  );
  await expect(page.getByRole('button', { name: 'Copy' })).toBeVisible();
  // The app itself did not start.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(statusBar(page)).toHaveCount(0);
  await screenshot(page, 'unsupported.png');
});
