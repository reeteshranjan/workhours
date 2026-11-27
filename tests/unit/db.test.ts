import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DatabaseSync as Database } from 'node:sqlite';
import { afterEach, describe, expect, test } from 'vitest';
import {
  backupIfDue,
  localDay,
  migrate,
  openDatabase,
  transaction,
} from '../../server/db/index.js';

const dbs: DatabaseSync[] = [];
const dirs: string[] = [];

function memoryDb(): DatabaseSync {
  const db = openDatabase(':memory:');
  dbs.push(db);
  return db;
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'workhours-test-'));
  dirs.push(dir);
  return dir;
}

function track(db: DatabaseSync): DatabaseSync {
  dbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of dbs.splice(0)) {
    if (db.isOpen) db.close();
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function userVersion(db: DatabaseSync): number {
  return Number(db.prepare('PRAGMA user_version').get()?.user_version);
}

function tableNames(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => String(r.name))
    .sort();
}

function addProject(db: DatabaseSync, name: string, status = 'active'): void {
  db.prepare('INSERT INTO projects (name, status, created_at) VALUES (?, ?, ?)').run(
    name,
    status,
    1000,
  );
}

function addSession(
  db: DatabaseSync,
  projectId: number,
  startedAt: number,
  endedAt: number | null,
  endReason: string | null,
): void {
  db.prepare(
    'INSERT INTO sessions (project_id, started_at, ended_at, end_reason) VALUES (?, ?, ?, ?)',
  ).run(projectId, startedAt, endedAt, endReason);
}

describe('migrate', () => {
  test('a fresh database is at version 1 with all tables', () => {
    const db = memoryDb();
    expect(userVersion(db)).toBe(1);
    expect(tableNames(db)).toEqual([
      'adjustments',
      'app_meta',
      'auto_pauses',
      'projects',
      'resets',
      'sessions',
    ]);
  });

  test('running migrate again returns 1 and changes nothing', () => {
    const db = memoryDb();
    const before = db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all();
    expect(migrate(db)).toBe(1);
    expect(userVersion(db)).toBe(1);
    expect(db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all()).toEqual(
      before,
    );
  });

  test('a gap in the migration numbers throws', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (id INTEGER);');
    writeFileSync(join(dir, '003_c.sql'), 'CREATE TABLE c (id INTEGER);');
    const db = track(new Database(':memory:'));
    expect(() => migrate(db, dir)).toThrow(/003_c\.sql/);
    expect(userVersion(db)).toBe(0);
  });

  test('a duplicate migration number throws', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (id INTEGER);');
    writeFileSync(join(dir, '001_b.sql'), 'CREATE TABLE b (id INTEGER);');
    const db = track(new Database(':memory:'));
    expect(() => migrate(db, dir)).toThrow(/no gaps or duplicates/);
  });

  test('files that do not match the naming pattern are ignored', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (id INTEGER);');
    writeFileSync(join(dir, 'README.md'), 'not a migration');
    writeFileSync(join(dir, '002_Bad-Name.sql'), 'this is not valid sql');
    const db = track(new Database(':memory:'));
    expect(migrate(db, dir)).toBe(1);
  });

  test('applies only the migrations above the current version', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (id INTEGER);');
    const db = track(new Database(':memory:'));
    expect(migrate(db, dir)).toBe(1);
    writeFileSync(join(dir, '002_b.sql'), 'CREATE TABLE b (id INTEGER);');
    expect(migrate(db, dir)).toBe(2);
    expect(tableNames(db)).toEqual(['a', 'b']);
  });

  test('a database from a newer version is refused', () => {
    const db = track(new Database(':memory:'));
    db.exec('PRAGMA user_version = 99');
    expect(() => migrate(db)).toThrow(
      'This database was created by a newer version of Work Hours (schema 99, this version knows 1).',
    );
  });

  test('a failing migration leaves the version unchanged and names the file', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '001_a.sql'), 'CREATE TABLE a (id INTEGER);');
    writeFileSync(join(dir, '002_bad.sql'), 'CREATE TABLE b (id INTEGER); THIS IS NOT VALID SQL;');
    const db = track(new Database(':memory:'));
    expect(() => migrate(db, dir)).toThrow(/002_bad\.sql/);
    expect(userVersion(db)).toBe(1);
    expect(tableNames(db)).toEqual(['a']);
  });
});

describe('openDatabase', () => {
  test('a file database uses WAL and enforces foreign keys', () => {
    const dir = tempDir();
    const db = track(openDatabase(join(dir, 'work.db')));
    expect(db.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
    expect(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys).toBe(1);
    expect(db.prepare('PRAGMA busy_timeout').get()?.timeout).toBe(5000);
    expect(userVersion(db)).toBe(1);
  });
});

describe('constraints', () => {
  test('project names are unique ignoring case', () => {
    const db = memoryDb();
    addProject(db, 'Acme');
    expect(() => addProject(db, 'ACME')).toThrow();
  });

  test('project names stay unique when the first project is closed', () => {
    const db = memoryDb();
    addProject(db, 'Acme', 'closed');
    expect(() => addProject(db, 'ACME')).toThrow();
  });

  test('project names must be trimmed', () => {
    const db = memoryDb();
    expect(() => addProject(db, ' Acme')).toThrow();
  });

  test('project names are limited to 100 characters', () => {
    const db = memoryDb();
    expect(() => addProject(db, 'a'.repeat(101))).toThrow();
    expect(() => addProject(db, 'a'.repeat(100))).not.toThrow();
  });

  test('project name length counts code points, not UTF-16 units', () => {
    const db = memoryDb();
    expect(() => addProject(db, '😀'.repeat(100))).not.toThrow();
    expect(() => addProject(db, '😀'.repeat(101))).toThrow();
  });

  test('project status must be active or closed', () => {
    const db = memoryDb();
    expect(() => addProject(db, 'Acme', 'archived')).toThrow();
  });

  test('only one session may be running', () => {
    const db = memoryDb();
    addProject(db, 'Acme');
    addSession(db, 1, 1000, null, null);
    expect(() => addSession(db, 1, 2000, null, null)).toThrow();
  });

  test('a session cannot end before it starts', () => {
    const db = memoryDb();
    addProject(db, 'Acme');
    expect(() => addSession(db, 1, 2000, 1000, 'switch')).toThrow();
  });

  test('an ended session needs an end reason', () => {
    const db = memoryDb();
    addProject(db, 'Acme');
    expect(() => addSession(db, 1, 1000, 2000, null)).toThrow();
  });

  test('a session end reason must be a known one', () => {
    const db = memoryDb();
    addProject(db, 'Acme');
    expect(() => addSession(db, 1, 1000, 2000, 'bogus')).toThrow();
    expect(() => addSession(db, 1, 1000, 2000, 'idle')).not.toThrow();
  });

  test('a session must belong to an existing project', () => {
    const db = memoryDb();
    expect(() => addSession(db, 999, 1000, 2000, 'switch')).toThrow();
  });

  test('a reset must be at least one minute', () => {
    const db = memoryDb();
    addProject(db, 'Acme');
    const insert = db.prepare(
      'INSERT INTO resets (project_id, reset_at, minutes) VALUES (?, ?, ?)',
    );
    expect(() => insert.run(1, 1000, 0)).toThrow();
    expect(() => insert.run(1, 1000, 1)).not.toThrow();
  });

  test('an adjustment cannot be zero minutes', () => {
    const db = memoryDb();
    addProject(db, 'Acme');
    const insert = db.prepare(
      'INSERT INTO adjustments (project_id, created_at, minutes, reason) VALUES (?, ?, ?, ?)',
    );
    expect(() => insert.run(1, 1000, 0, 'fix')).toThrow();
    expect(() => insert.run(1, 1000, -5, 'fix')).not.toThrow();
  });

  test('an adjustment reason must be non-empty and trimmed', () => {
    const db = memoryDb();
    addProject(db, 'Acme');
    const insert = db.prepare(
      'INSERT INTO adjustments (project_id, created_at, minutes, reason) VALUES (?, ?, ?, ?)',
    );
    expect(() => insert.run(1, 1000, 5, '')).toThrow();
    expect(() => insert.run(1, 1000, 5, ' x')).toThrow();
  });

  test('an auto pause resolution must be a known one', () => {
    const db = memoryDb();
    addProject(db, 'Acme');
    addSession(db, 1, 1000, 2000, 'idle');
    const insert = db.prepare(
      'INSERT INTO auto_pauses (session_id, detected_at, resolution) VALUES (?, ?, ?)',
    );
    expect(() => insert.run(1, 3000, 'later')).toThrow();
    expect(() => insert.run(1, 3000, 'counted')).not.toThrow();
  });
});

describe('transaction', () => {
  function count(db: DatabaseSync): number {
    return Number(db.prepare('SELECT count(*) AS n FROM projects').get()?.n);
  }

  test('commits on success and returns the result', () => {
    const db = memoryDb();
    const result = transaction(db, () => {
      addProject(db, 'Acme');
      return 42;
    });
    expect(result).toBe(42);
    expect(db.isTransaction).toBe(false);
    expect(count(db)).toBe(1);
  });

  test('rolls back and rethrows when the callback throws', () => {
    const db = memoryDb();
    expect(() =>
      transaction(db, () => {
        addProject(db, 'Acme');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.isTransaction).toBe(false);
    expect(count(db)).toBe(0);
  });

  test('a nested call joins the outer transaction', () => {
    const db = memoryDb();
    expect(() =>
      transaction(db, () => {
        transaction(db, () => addProject(db, 'Acme'));
        // The inner call must not have committed.
        expect(db.isTransaction).toBe(true);
        expect(count(db)).toBe(1);
        throw new Error('outer fails');
      }),
    ).toThrow('outer fails');
    expect(count(db)).toBe(0);
  });

  test('returning a promise throws and rolls back', () => {
    const db = memoryDb();
    expect(() =>
      transaction(db, () => {
        addProject(db, 'Acme');
        return Promise.resolve(1);
      }),
    ).toThrow(/synchronous/);
    expect(db.isTransaction).toBe(false);
    expect(count(db)).toBe(0);
  });
});

describe('backup', () => {
  const now = new Date(2026, 10, 3, 12, 0).getTime();

  function fileDb(dir: string): DatabaseSync {
    const db = track(openDatabase(join(dir, 'work.db')));
    addProject(db, 'Acme');
    return db;
  }

  function backupNames(dataDir: string): string[] {
    return readdirSync(join(dataDir, 'backups'))
      .filter((n) => /^workhours-.*\.db$/.test(n))
      .sort();
  }

  test('localDay formats local dates', () => {
    expect(localDay(new Date(2026, 10, 3, 23, 59).getTime())).toBe('2026-11-03');
    expect(localDay(new Date(2026, 0, 5, 0, 0).getTime())).toBe('2026-01-05');
  });

  test('creates a usable backup once per day', () => {
    const dir = tempDir();
    const db = fileDb(dir);
    const path = backupIfDue(db, dir, now);
    expect(path).toBe(join(dir, 'backups', 'workhours-2026-11-03.db'));
    expect(existsSync(path as string)).toBe(true);

    const copy = track(new Database(path as string, { readOnly: true }));
    expect(copy.prepare('SELECT name FROM projects').all()).toEqual([{ name: 'Acme' }]);

    expect(backupIfDue(db, dir, now)).toBeNull();
  });

  test('refuses to run inside a transaction', () => {
    const dir = tempDir();
    const db = fileDb(dir);
    expect(() => transaction(db, () => backupIfDue(db, dir, now))).toThrow(/transaction/);
  });

  test('keeps the newest 14 backups and leaves other files alone', () => {
    const dir = tempDir();
    const db = fileDb(dir);
    const backups = join(dir, 'backups');
    mkdirSync(backups);
    for (let day = 1; day <= 16; day++) {
      writeFileSync(join(backups, `workhours-2026-01-${String(day).padStart(2, '0')}.db`), 'x');
    }
    writeFileSync(join(backups, 'notes.txt'), 'keep me');

    const path = backupIfDue(db, dir, now);
    expect(path).not.toBeNull();

    const remaining = backupNames(dir);
    expect(remaining).toHaveLength(14);
    expect(remaining.at(-1)).toBe('workhours-2026-11-03.db');
    // New backup + the 13 newest dummies (Jan 4 .. Jan 16).
    expect(remaining[0]).toBe('workhours-2026-01-04.db');
    expect(existsSync(join(backups, 'notes.txt'))).toBe(true);
  });
});
