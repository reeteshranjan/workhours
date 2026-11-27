import { defineConfig } from '@playwright/test';

// End-to-end tests (DESIGN §14): the built app, served by the real CLI on its own port with its
// own data folder, driven through the installed Google Chrome (no browser download).
// `npm run test:e2e` builds first; running `npx playwright test` alone uses the existing dist/.
const PORT = 7498;

export default defineConfig({
  testDir: 'tests/e2e',
  // One shared server and database, so the tests run one after another.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: 'chrome',
    headless: true,
    viewport: { width: 900, height: 800 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    // The script empties .e2e-data first, then starts the CLI with these arguments. Playwright
    // starts the web server before globalSetup runs, so a global setup couldn't do that in time.
    command: `node scripts/e2e-server.mjs --no-open --port ${PORT} --data .e2e-data`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
