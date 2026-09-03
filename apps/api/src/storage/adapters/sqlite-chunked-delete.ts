/**
 * Minimal structural view of the better-sqlite3 / libsql driver surface the
 * chunked delete needs.
 */
interface SqliteLikeDb {
  prepare(sql: string): { run(...params: unknown[]): { changes: number } };
}

const CHUNK_SIZE = 10_000;

/**
 * Deletes matching rows in bounded batches, yielding to the event loop
 * between batches. better-sqlite3 executes synchronously, so a single DELETE
 * over a year of keep-forever history would otherwise block HTTP, websockets
 * and every poller for the whole pass — the retention sweeps call the prune
 * methods with no connection scope and no upper bound on matched rows.
 *
 * All tables here are ordinary rowid tables (none are WITHOUT ROWID), so the
 * `rowid IN (SELECT rowid ... LIMIT n)` form is valid everywhere.
 */
export async function chunkedSqliteDelete(
  db: SqliteLikeDb,
  table: string,
  where: string,
  params: unknown[],
): Promise<number> {
  const stmt = db.prepare(
    `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${where} LIMIT ${CHUNK_SIZE})`,
  );
  let total = 0;
  for (;;) {
    const { changes } = stmt.run(...params);
    total += changes;
    // Terminate only on a fully-empty batch, matching the postgres twin. A
    // short-batch exit would also be sound here (SQLite serializes writers),
    // but keeping both helpers on the same condition means a future refactor
    // can't accidentally port the laxer form to the dialect where it's a bug.
    if (changes === 0) break;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return total;
}
