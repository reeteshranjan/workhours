import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';

// Guards the toolchain: node:sqlite must load under Vitest (the app's database, DESIGN §2).
test('node:sqlite opens an in-memory database', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const row = db.prepare('select sqlite_version() as v').get();
    expect(typeof row?.v).toBe('string');
  } finally {
    db.close();
  }
});
