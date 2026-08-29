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
 * better-sqlite3's fluent statement modifiers. Each mutates the statement and
 * returns it, so a re-prepared statement has to be told about them again or it
 * comes back with the modifier silently dropped.
 */
const FLUENT_STATEMENT_METHODS = new Set(['pluck', 'expand', 'raw', 'safeIntegers', 'bind']);

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
  const modifiers: { name: string; args: unknown[] }[] = [];

  const ensure = (): StatementRecord => {
    if (statement === null || preparedAt !== readGeneration()) {
      statement = prepare(sql);
      preparedAt = readGeneration();
      for (const modifier of modifiers) {
        const method = (statement as unknown as StatementRecord)[modifier.name];
        (method as (...args: unknown[]) => unknown).apply(statement, modifier.args);
      }
    }
    return statement as unknown as StatementRecord;
  };

  const target = {} as StatementRecord;

  const proxy: Database.Statement = new Proxy(target, {
    get(_target, property: string | symbol): unknown {
      const current = ensure();
      const value = current[property as string];
      if (typeof value !== 'function') {
        return value;
      }

      const name = String(property);
      return (...args: unknown[]): unknown => {
        // ensure() again: an earlier argument may have crossed a transaction
        // boundary, and `current` would then be prepared on a dead stream.
        const live = ensure();
        const result = (live[name] as (...a: unknown[]) => unknown).apply(live, args);
        if (result !== live) {
          return result;
        }
        // A fluent modifier returned the statement. Record it so a re-prepare
        // replays it, and hand back the proxy so the chain stays wrapped.
        if (FLUENT_STATEMENT_METHODS.has(name)) {
          modifiers.push({ name, args });
        }
        return proxy;
      };
    },
  }) as unknown as Database.Statement;

  return proxy;
}

function patchForRemote(db: Database.Database): void {
  const nativePrepare = db.prepare.bind(db);
  const nativeExec = db.exec.bind(db);

  let generation = 0;
  let depth = 0;
  let rollbackOnly = false;

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
        // A nested body must be able to unwind on its own. Without a savepoint
        // its writes ride on the outer COMMIT even when it threw and the outer
        // body swallowed the error.
        const savepoint = `betterdb_sp_${depth}`;
        nativeExec(`SAVEPOINT ${savepoint}`);
        depth += 1;
        try {
          const result = fn(...args);
          nativeExec(`RELEASE ${savepoint}`);
          return result;
        } catch (error) {
          try {
            nativeExec(`ROLLBACK TO ${savepoint}`);
            nativeExec(`RELEASE ${savepoint}`);
          } catch {
            // The savepoint did not unwind, so whatever the nested body wrote is
            // still live. The outer body may swallow this error, so the outer
            // transaction has to be barred from committing.
            rollbackOnly = true;
          }
          throw error;
        } finally {
          depth -= 1;
        }
      }

      nativeExec('BEGIN');
      generation += 1;
      depth = 1;
      rollbackOnly = false;
      let unwound = false;
      try {
        const result = fn(...args);
        if (rollbackOnly) {
          unwound = true;
          try {
            nativeExec('ROLLBACK');
          } catch {
            // The server already unwound the transaction.
          }
          throw new Error('Transaction rolled back: a nested savepoint could not be unwound');
        }
        nativeExec('COMMIT');
        return result;
      } catch (error) {
        if (!unwound) {
          try {
            nativeExec('ROLLBACK');
          } catch {
            // The server already unwound the transaction; surface the original error.
          }
        }
        throw error;
      } finally {
        depth = 0;
        generation += 1;
        rollbackOnly = false;
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
