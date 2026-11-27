// Helpers shared by the end-to-end specs.
import type { BrowserContext, Page } from '@playwright/test';

/** The localStorage flag the setup dialog sets (web/src/lib/setup.ts). */
const SETUP_COMPLETE_KEY = 'workhours:setup-complete';

/**
 * Makes every page in the context load as if the first-run setup was done, so the welcome dialog
 * doesn't cover the page. The script is a string because these files have no DOM types.
 */
export async function skipSetup(context: BrowserContext): Promise<void> {
  await context.addInitScript(`localStorage.setItem('${SETUP_COMPLETE_KEY}', '1');`);
}

/** A picture of the page in test-results/screens/, with the bundled fonts loaded. */
export async function screenshot(page: Page, file: string): Promise<void> {
  // Wait for the bundled fonts, so that the picture shows the real typography.
  await page.evaluate('document.fonts.ready.then(() => undefined)');
  // Let finite animations (the cards sliding into place) end; the running dot's pulse never does.
  await page.evaluate(
    'Promise.all(document.getAnimations().filter((a) => a.effect && a.effect.getComputedTiming().endTime !== Infinity).map((a) => a.finished.catch(() => undefined))).then(() => undefined)',
  );
  await page.screenshot({ path: `test-results/screens/${file}` });
}
