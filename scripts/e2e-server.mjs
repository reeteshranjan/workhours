// Starts the built server for the end-to-end tests (playwright.config.ts) on an empty database.
// It takes the same arguments as `workhours`. The tests pass `--data .e2e-data`, the folder this
// script empties first, so that every run starts fresh.
import { rmSync } from 'node:fs';
import { join } from 'node:path';

rmSync(join(import.meta.dirname, '..', '.e2e-data'), { recursive: true, force: true });
await import('../dist/server/cli.js');
