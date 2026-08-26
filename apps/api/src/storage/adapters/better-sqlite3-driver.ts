import type Database from 'better-sqlite3';

type BetterSqlite3Constructor = new (path: string) => Database.Database;

export async function loadBetterSqlite3(): Promise<BetterSqlite3Constructor> {
  try {
    const imported = (await import('better-sqlite3')) as unknown as {
      default: BetterSqlite3Constructor;
    };
    return imported.default;
  } catch (error) {
    throw new Error(
      'Local SQLite files require the better-sqlite3 native module, which is not installed in this build. Use STORAGE_TYPE=turso with a remote STORAGE_URL, or STORAGE_TYPE=postgres.',
      { cause: error },
    );
  }
}
