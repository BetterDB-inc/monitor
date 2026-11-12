import { isAuthErrorReply } from '../auth-error';

describe('isAuthErrorReply', () => {
  it.each([
    'WRONGPASS invalid username-password pair or user is disabled.',
    'NOAUTH Authentication required.',
    "NOPERM User monitor has no permissions to run the 'info' command",
    'ERR invalid password',
    'ERR AUTH <password> called without any password configured for the default user.',
    'ERR Client sent AUTH, but no password is set',
    'Connection failed: WRONGPASS invalid username-password pair',
  ])('reads %s as a refusal', (message) => {
    expect(isAuthErrorReply(message)).toBe(true);
  });

  it.each([
    'connect ETIMEDOUT redis-noauth-0:6379',
    'Cannot connect to wrongpass-cluster.internal:6379',
    'getaddrinfo ENOTFOUND noperm-node',
    'INFO to 10.0.1.5:6379 timed out',
    'ERR unknown command',
  ])('does not read %s as a refusal', (message) => {
    expect(isAuthErrorReply(message)).toBe(false);
  });
});
