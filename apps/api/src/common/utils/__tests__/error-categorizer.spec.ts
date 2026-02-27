import { categorizeError } from '../error-categorizer';

describe('categorizeError', () => {
  it.each([
    ['connect ECONNREFUSED 127.0.0.1:6379', 'connection_refused'],
    ['connect ECONNREFUSED ::1:6379', 'connection_refused'],
    ['listen EADDRINUSE: address already in use 0.0.0.0:3001', 'port_in_use'],
    ['NOAUTH Authentication required', 'auth_failed'],
    ['WRONGPASS invalid username-password pair', 'auth_failed'],
    ['ERR AUTH <password> called without password set', 'auth_failed'],
    ['connect ETIMEDOUT 10.0.0.1:6379', 'timeout'],
    ['read ECONNRESET', 'timeout'],
    ['operation timeout after 5000ms', 'timeout'],
    ['Failed to initialize storage engine', 'storage_init'],
    ['ENOENT: no such file or directory, open /data/betterdb.db', 'storage_init'],
    ['sqlite: unable to open database', 'storage_init'],
    ['Invalid environment variable: PORT must be a number', 'config_invalid'],
    ['Environment validation failed: DB_HOST is required', 'config_invalid'],
    ['missing required config: STORAGE_URL', 'config_invalid'],
    ['Something completely unexpected happened', 'unknown'],
  ])('categorizes "%s" as %s', (message, expected) => {
    expect(categorizeError(new Error(message))).toBe(expected);
  });

  it('returns unknown for error with empty message', () => {
    expect(categorizeError(new Error(''))).toBe('unknown');
  });
});
