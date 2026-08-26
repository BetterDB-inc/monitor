import type Database from 'better-sqlite3';

export interface LibsqlConnectionOptions {
  url: string;
  authToken?: string;
}

type LibsqlConstructor = new (path: string, options?: { authToken?: string }) => Database.Database;

type VariadicFunction = (...args: never[]) => unknown;

type StatementRecord = Record<string, unknown>;

const REMOTE_URL_PREFIXES = ['libsql://', 'https://', 'http://', 'wss://', 'ws://'];

export function isRemoteLibsqlUrl(url: string): boolean {
  return REMOTE_URL_PREFIXES.some((prefix) => {
    return url.startsWith(prefix);
  });
}

/**
 * Remote libSQL executes each statement on its own implicit stream. A statement
 * prepared before BEGIN therefore runs outside the transaction, which ends it and
 * silently discards the write. Statements are re-prepared whenever a transaction
 * boundary is crossed so every statement executes on the stream that owns it.
 */
function createLazyStatement(
  prepare: (sql: string) => Database.Statement,
  sql: string,
  readGeneration: () => number,
): Database.Statement {
  let statement: Database.Statement | null = null;
  let preparedAt = -1;

  const ensure = (): Database.Statement => {
    if (statement === null || preparedAt !== readGeneration()) {
      statement = prepare(sql);
      preparedAt = readGeneration();
    }
    return statement;
  };

  const target = {} as StatementRecord;

  return new Proxy(target, {
    get(_target, property: string | symbol): unknown {
      const current = ensure() as unknown as StatementRecord;
      const value = current[property as string];
      if (typeof value === 'function') {
        return (value as (...args: unknown[]) => unknown).bind(current);
      }
      return value;
    },
  }) as unknown as Database.Statement;
}

function patchForRemote(db: Database.Database): void {
  const nativePrepare = db.prepare.bind(db);
  const nativeExec = db.exec.bind(db);

  let generation = 0;
  let depth = 0;

  const readGeneration = (): number => {
    return generation;
  };

  Object.defineProperty(db, 'prepare', {
    value: (sql: string): Database.Statement => {
      return createLazyStatement(nativePrepare, sql, readGeneration);
    },
    writable: true,
    configurable: true,
  });

  const transaction = <F extends VariadicFunction>(fn: F): F => {
    const wrapped = (...args: Parameters<F>): unknown => {
      if (depth > 0) {
        depth += 1;
        try {
          return fn(...args);
        } finally {
          depth -= 1;
        }
      }

      nativeExec('BEGIN');
      generation += 1;
      depth = 1;
      try {
        const result = fn(...args);
        nativeExec('COMMIT');
        return result;
      } catch (error) {
        try {
          nativeExec('ROLLBACK');
        } catch {
          // The server already unwound the transaction; surface the original error.
        }
        throw error;
      } finally {
        depth = 0;
        generation += 1;
      }
    };

    return wrapped as unknown as F;
  };

  Object.defineProperty(db, 'transaction', {
    value: transaction,
    writable: true,
    configurable: true,
  });
}

export async function openLibsqlDatabase(
  options: LibsqlConnectionOptions,
): Promise<Database.Database> {
  const imported = (await import('libsql')) as unknown as { default: LibsqlConstructor };
  const LibsqlDatabase = imported.default;

  const db = new LibsqlDatabase(options.url, { authToken: options.authToken });

  if (isRemoteLibsqlUrl(options.url)) {
    patchForRemote(db);
  }

  return db;
}
