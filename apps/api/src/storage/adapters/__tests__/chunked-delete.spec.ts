import Database from 'better-sqlite3';
import { chunkedSqliteDelete } from '../sqlite-chunked-delete';

describe('chunkedSqliteDelete', () => {
  it('deletes across multiple chunks and reports the full count', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE samples (id INTEGER PRIMARY KEY, captured_at INTEGER NOT NULL)');

    const insert = db.prepare('INSERT INTO samples (captured_at) VALUES (?)');
    const insertMany = db.transaction((rows: number[]) => {
      for (const ts of rows) insert.run(ts);
    });
    // 25k old rows (several chunks at the 2k chunk size) + 100 recent ones.
    insertMany(Array.from({ length: 25_000 }, (_, i) => i));
    insertMany(Array.from({ length: 100 }, (_, i) => 1_000_000 + i));

    const deleted = await chunkedSqliteDelete(db, 'samples', 'captured_at < ?', [25_000]);

    expect(deleted).toBe(25_000);
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM samples').get() as { n: number };
    expect(remaining.n).toBe(100);
    db.close();
  });

  it('supports compound where clauses with multiple params', async () => {
    const db = new Database(':memory:');
    db.exec(
      'CREATE TABLE samples (id INTEGER PRIMARY KEY, captured_at INTEGER NOT NULL, connection_id TEXT NOT NULL)',
    );
    const insert = db.prepare('INSERT INTO samples (captured_at, connection_id) VALUES (?, ?)');
    insert.run(1, 'a');
    insert.run(1, 'b');
    insert.run(100, 'a');

    const deleted = await chunkedSqliteDelete(
      db,
      'samples',
      'captured_at < ? AND connection_id = ?',
      [50, 'a'],
    );

    expect(deleted).toBe(1);
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM samples').get() as { n: number };
    expect(remaining.n).toBe(2);
    db.close();
  });
});
