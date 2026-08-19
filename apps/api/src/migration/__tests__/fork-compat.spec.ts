import { shouldExcludeFunctions, probeSourceFunctions, aggregateFunctionPresence } from '../fork-compat';

describe('shouldExcludeFunctions', () => {
  it('excludes only for Valkey -> Redis', () => {
    expect(shouldExcludeFunctions('valkey', 'redis')).toBe(true);
    expect(shouldExcludeFunctions('redis', 'valkey')).toBe(false);
    expect(shouldExcludeFunctions('valkey', 'valkey')).toBe(false);
    expect(shouldExcludeFunctions('redis', 'redis')).toBe(false);
  });
});

describe('probeSourceFunctions', () => {
  const clientReturning = (impl: () => Promise<unknown>) => ({ call: jest.fn(impl) });

  it("returns 'present' when FUNCTION LIST reports libraries", async () => {
    const client = clientReturning(async () => [['library_name', 'mylib']]);
    expect(await probeSourceFunctions(client)).toBe('present');
  });

  it("returns 'absent' when FUNCTION LIST is empty", async () => {
    const client = clientReturning(async () => []);
    expect(await probeSourceFunctions(client)).toBe('absent');
  });

  it("returns 'absent' when the engine has no FUNCTION command (Redis < 7.0)", async () => {
    // Redis 6 and non-Valkey/Redis engines reply "unknown command" — that's
    // definitively no functions, so a clean old instance must still report no issues.
    const client = clientReturning(async () => {
      throw new Error("ERR unknown command 'FUNCTION', with args beginning with: 'LIST'");
    });
    expect(await probeSourceFunctions(client)).toBe('absent');
  });

  it("returns 'unknown' when the probe is blocked by ACL permissions", async () => {
    const client = clientReturning(async () => {
      throw new Error("NOPERM this user has no permissions to run the 'function|list' command");
    });
    expect(await probeSourceFunctions(client)).toBe('unknown');
  });

  it("returns 'unknown' on a connection/routing error", async () => {
    const client = clientReturning(async () => {
      throw new Error('Connection is closed.');
    });
    expect(await probeSourceFunctions(client)).toBe('unknown');
  });
});

describe('aggregateFunctionPresence', () => {
  it("is 'present' if ANY node reports a library (node-local FUNCTION LIST)", () => {
    // The whole point: a library on the second master is invisible to a probe of the
    // first, so one 'present' wins.
    expect(aggregateFunctionPresence(['absent', 'present'])).toBe('present');
    expect(aggregateFunctionPresence(['present', 'unknown'])).toBe('present');
  });

  it("is 'unknown' when none are present but any node was indeterminate", () => {
    expect(aggregateFunctionPresence(['absent', 'unknown'])).toBe('unknown');
    expect(aggregateFunctionPresence(['unknown', 'unknown'])).toBe('unknown');
  });

  it("is 'absent' only when every node answered with no functions", () => {
    expect(aggregateFunctionPresence(['absent', 'absent'])).toBe('absent');
  });

  it("is 'unknown' for an empty result set — can't claim absence", () => {
    expect(aggregateFunctionPresence([])).toBe('unknown');
  });
});
