import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrate.js';

/** Opens (creating if needed) the database at `file`, applies pragmas and runs migrations. */
export function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  try {
    if (file !== ':memory:') {
      db.exec('PRAGMA journal_mode = WAL');
    }
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    migrate(db);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}
