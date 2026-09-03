/**
 * Minimal structural view of the pg Pool surface the chunked delete needs.
 */
interface PgPoolLike {
  query(sql: string, params?: unknown[]): Promise<{ rowCount: number | null }>;
}

const CHUNK_SIZE = 10_000;

/**
 * Deletes matching rows in bounded batches. A single unbounded DELETE over
 * years of keep-forever history holds row locks and a pool connection for
 * minutes per table and writes the whole prune as one WAL transaction; the
 * ctid batches keep each transaction small so autovacuum and the hourly
 * poller prunes can interleave.
 */
export async function chunkedPostgresDelete(
  pool: PgPoolLike,
  table: string,
  where: string,
  params: unknown[],
): Promise<number> {
  let total = 0;
  for (;;) {
    const result = await pool.query(
      `DELETE FROM ${table} WHERE ctid = ANY(ARRAY(SELECT ctid FROM ${table} WHERE ${where} LIMIT ${CHUNK_SIZE}))`,
      params,
    );
    const changes = result.rowCount ?? 0;
    total += changes;
    // Terminate only on a fully-empty batch. Under READ COMMITTED a
    // concurrent prune/UPDATE can shrink a batch's rowCount below CHUNK_SIZE
    // (deleted tuples are skipped, updated tuples move to new ctids) while
    // matching rows remain — `changes < CHUNK_SIZE` would exit early and
    // leave them behind. The cost is one extra confirming round-trip.
    if (changes === 0) break;
  }
  return total;
}
