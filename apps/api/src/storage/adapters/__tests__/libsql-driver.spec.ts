import { isRemoteLibsqlUrl, openLibsqlDatabase } from '../libsql-driver';

type CallLog = string[];

class FakeStatement {
  constructor(
    private readonly sql: string,
    private readonly log: CallLog,
  ) {}

  run(): { changes: number } {
    this.log.push(`run:${this.sql}`);
    return { changes: 1 };
  }

  get(): { value: number } {
    this.log.push(`get:${this.sql}`);
    return { value: 1 };
  }
}

class FakeDatabase {
  constructor(
    public readonly path: string,
    public readonly options: { authToken?: string } | undefined,
    public readonly log: CallLog,
  ) {}

  prepare(sql: string): FakeStatement {
    this.log.push(`prepare:${sql}`);
    return new FakeStatement(sql, this.log);
  }

  failExec: string | null = null;

  exec(sql: string): void {
    this.log.push(`exec:${sql}`);
    if (this.failExec === sql) {
      throw new Error('no transaction is active');
    }
  }

  transaction<F extends (...args: never[]) => unknown>(fn: F): F {
    this.log.push('native-transaction');
    return fn;
  }
}

const constructed: FakeDatabase[] = [];
let log: CallLog = [];

jest.mock('libsql', () => {
  return {
    __esModule: true,
    default: class {
      constructor(path: string, options?: { authToken?: string }) {
        const db = new FakeDatabase(path, options, log);
        constructed.push(db);
        return db as unknown as never;
      }
    },
  };
});

const REMOTE_URL = 'libsql://example-org.turso.io';

async function openRemote(): Promise<FakeDatabase> {
  await openLibsqlDatabase({ url: REMOTE_URL, authToken: 'token-123' });
  return constructed[constructed.length - 1];
}

describe('isRemoteLibsqlUrl', () => {
  it.each([
    'libsql://db.turso.io',
    'https://db.turso.io',
    'http://127.0.0.1:8080',
    'wss://db',
    'ws://db',
  ])('treats %s as remote', (url) => {
    expect(isRemoteLibsqlUrl(url)).toBe(true);
  });

  it.each(['./data/audit.db', '/var/lib/audit.db', 'file:local.db', ':memory:'])(
    'treats %s as local',
    (url) => {
      expect(isRemoteLibsqlUrl(url)).toBe(false);
    },
  );
});

describe('openLibsqlDatabase', () => {
  beforeEach(() => {
    constructed.length = 0;
    log = [];
  });

  it('forwards the auth token to the libsql constructor', async () => {
    const db = await openRemote();
    expect(db.path).toBe(REMOTE_URL);
    expect(db.options).toEqual({ authToken: 'token-123' });
  });

  it('leaves a local database unpatched', async () => {
    await openLibsqlDatabase({ url: './data/audit.db' });
    const db = constructed[constructed.length - 1];

    const statement = db.prepare('SELECT 1');
    statement.run();

    expect(log).toEqual(['prepare:SELECT 1', 'run:SELECT 1']);
  });

  it('defers preparation until the statement is used', async () => {
    const db = await openRemote();

    db.prepare('SELECT 1');
    expect(log).toEqual([]);
  });

  it('re-prepares a statement created before BEGIN so it runs inside the transaction', async () => {
    const db = await openRemote();

    const insert = db.prepare('INSERT INTO t VALUES (?)');
    const runTransaction = db.transaction(() => {
      insert.run();
    });
    runTransaction();

    expect(log).toEqual([
      'exec:BEGIN',
      'prepare:INSERT INTO t VALUES (?)',
      'run:INSERT INTO t VALUES (?)',
      'exec:COMMIT',
    ]);
  });

  it('re-prepares again once the transaction has ended', async () => {
    const db = await openRemote();

    const insert = db.prepare('INSERT INTO t VALUES (?)');
    insert.run();
    db.transaction(() => {
      insert.run();
    })();
    insert.run();

    expect(
      log.filter((entry) => {
        return entry.startsWith('prepare:');
      }),
    ).toHaveLength(3);
  });

  it('reuses a prepared statement while the generation is unchanged', async () => {
    const db = await openRemote();

    const select = db.prepare('SELECT 1');
    select.get();
    select.get();

    expect(log).toEqual(['prepare:SELECT 1', 'get:SELECT 1', 'get:SELECT 1']);
  });

  it('rolls back and rethrows when the transaction body fails', async () => {
    const db = await openRemote();

    const failing = db.transaction(() => {
      throw new Error('constraint failed');
    });

    expect(failing).toThrow('constraint failed');
    expect(log).toEqual(['exec:BEGIN', 'exec:ROLLBACK']);
  });

  it('does not open a second transaction when transactions nest', async () => {
    const db = await openRemote();

    const inner = db.transaction(() => {
      db.prepare('INSERT INTO inner VALUES (1)').run();
    });
    const outer = db.transaction(() => {
      db.prepare('INSERT INTO outer VALUES (1)').run();
      inner();
    });
    outer();

    expect(
      log.filter((entry) => {
        return entry === 'exec:BEGIN';
      }),
    ).toHaveLength(1);
    expect(
      log.filter((entry) => {
        return entry === 'exec:COMMIT';
      }),
    ).toHaveLength(1);
  });

  it('surfaces the original error when the rollback itself fails', async () => {
    const db = await openRemote();
    // The driver binds exec at patch time, so the failure has to come from the
    // database itself: a spy installed here would never be reached.
    (db as unknown as FakeDatabase).failExec = 'ROLLBACK';

    const failing = db.transaction(() => {
      throw new Error('constraint failed');
    });

    expect(failing).toThrow('constraint failed');
    expect(log).toEqual(['exec:BEGIN', 'exec:ROLLBACK']);
  });

  it('unwinds a nested body to its savepoint when the outer body swallows the error', async () => {
    const db = await openRemote();

    const inner = db.transaction(() => {
      db.prepare('INSERT INTO inner VALUES (1)').run();
      throw new Error('inner failed');
    });
    const outer = db.transaction(() => {
      db.prepare('INSERT INTO outer VALUES (1)').run();
      try {
        inner();
      } catch {
        // swallowed on purpose: the outer body decides to carry on
      }
    });

    outer();

    expect(log).toEqual([
      'exec:BEGIN',
      'prepare:INSERT INTO outer VALUES (1)',
      'run:INSERT INTO outer VALUES (1)',
      'exec:SAVEPOINT betterdb_sp_1',
      'prepare:INSERT INTO inner VALUES (1)',
      'run:INSERT INTO inner VALUES (1)',
      'exec:ROLLBACK TO betterdb_sp_1',
      'exec:RELEASE betterdb_sp_1',
      'exec:COMMIT',
    ]);
  });
});
