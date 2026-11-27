// The last build step. Copies the SQL migrations next to the compiled server, since tsc only emits
// .js files, and makes the CLI executable again.
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const from = join(root, 'server', 'db', 'migrations');
const to = join(root, 'dist', 'server', 'db', 'migrations');

if (existsSync(from)) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    if (name.endsWith('.sql')) {
      cpSync(join(from, name), join(to, name));
    }
  }
}

// `npm link` marks the CLI executable only once, when linking. The build deletes dist/ and tsc
// writes the file anew without that mark, so the linked `workhours` command would fail with
// "permission denied" after every rebuild. Windows has no such mark and ignores this.
chmodSync(join(root, 'dist', 'server', 'cli.js'), 0o755);
