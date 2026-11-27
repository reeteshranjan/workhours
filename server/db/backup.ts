import { mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

const BACKUP_FILE = /^workhours-\d{4}-\d{2}-\d{2}\.db$/;

/** Local-time calendar day of an epoch-millisecond timestamp, as YYYY-MM-DD. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  const yyyy = String(d.getFullYear()).padStart(4, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Writes today's backup (`<dataDir>/backups/workhours-YYYY-MM-DD.db`) unless it already exists,
 * then keeps only the newest `keep` backups. Returns the new file's path, or null if none was made.
 */
export function backupIfDue(
  db: DatabaseSync,
  dataDir: string,
  now: number,
  keep = 14,
): string | null {
  if (db.isTransaction) {
    throw new Error('Cannot back up inside a transaction (VACUUM INTO cannot run in one).');
  }
  const dir = join(dataDir, 'backups');
  const target = join(dir, `workhours-${localDay(now)}.db`);
  if (existsSync(target)) {
    return null;
  }
  mkdirSync(dir, { recursive: true });
  db.prepare('VACUUM INTO ?').run(target);

  const backups = readdirSync(dir)
    .filter((name) => BACKUP_FILE.test(name))
    .sort()
    .reverse();
  for (const name of backups.slice(keep)) {
    rmSync(join(dir, name), { force: true });
  }
  return target;
}
