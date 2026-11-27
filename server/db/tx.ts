import type { DatabaseSync } from 'node:sqlite';

/**
 * Runs `fn` in a write transaction (BEGIN IMMEDIATE ... COMMIT), rolling back if it throws.
 * Nesting-safe: inside an open transaction, `fn` just runs and the outer transaction owns
 * commit and rollback. `fn` must be synchronous.
 */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) {
    return fn();
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    if (isThenable(result)) {
      throw new Error('Transactions must be synchronous: the callback returned a promise.');
    }
    db.exec('COMMIT');
    return result;
  } catch (err) {
    if (db.isTransaction) {
      db.exec('ROLLBACK');
    }
    throw err;
  }
}

function isThenable(value: unknown): boolean {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}
