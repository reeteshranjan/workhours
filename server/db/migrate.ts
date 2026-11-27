import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './tx.js';

// Resolves next to this file under tsx (server/db/) and after the build (dist/server/db/).
export const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

const MIGRATION_FILE = /^(\d{3})_[a-z0-9_]+\.sql$/;

interface Migration {
  version: number;
  file: string;
}

function listMigrations(dir: string): Migration[] {
  const migrations: Migration[] = [];
  for (const file of readdirSync(dir)) {
    const match = MIGRATION_FILE.exec(file);
    if (match?.[1] !== undefined) {
      migrations.push({ version: Number(match[1]), file });
    }
  }
  migrations.sort((a, b) => a.version - b.version);
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(
        `Migrations in ${dir} must be numbered 1..N with no gaps or duplicates; ` +
          `expected ${String(i + 1).padStart(3, '0')} but found ${m.file}.`,
      );
    }
  });
  return migrations;
}

/** Applies pending migrations in order and returns the resulting schema version. */
export function migrate(db: DatabaseSync, dir: string = DEFAULT_MIGRATIONS_DIR): number {
  const migrations = listMigrations(dir);
  const latest = migrations.length;
  const row = db.prepare('PRAGMA user_version').get();
  const current = Number(row?.user_version ?? 0);

  if (current > latest) {
    throw new Error(
      'This database was created by a newer version of Work Hours (schema ' +
        current +
        ', this version knows ' +
        latest +
        ').',
    );
  }

  for (const { version, file } of migrations) {
    if (version <= current) continue;
    try {
      const sql = readFileSync(join(dir, file), 'utf8');
      transaction(db, () => {
        db.exec(sql);
        db.exec('PRAGMA user_version = ' + version);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Migration ${file} failed: ${message}`, { cause: err });
    }
  }
  return latest;
}
