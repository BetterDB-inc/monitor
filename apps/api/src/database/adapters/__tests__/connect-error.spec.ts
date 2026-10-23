import Valkey from 'iovalkey';
import { describeConnectError } from '../connect-error';
import { UnifiedDatabaseAdapter } from '../unified.adapter';

describe('describeConnectError', () => {
  it.each([
    ['ENOTFOUND', 'Host "bad-host" could not be found'],
    ['ENODATA', 'Host "bad-host" could not be found'],
    ['EAI_AGAIN', 'DNS lookup for "bad-host" failed'],
    ['ECONNREFUSED', 'Connection refused by bad-host:6379'],
    ['ETIMEDOUT', 'Timed out connecting to bad-host:6379'],
    ['EHOSTUNREACH', 'bad-host:6379 is unreachable'],
    ['ENETUNREACH', 'bad-host:6379 is unreachable'],
  ])('describes %s', (code, expected) => {
    expect(describeConnectError({ code }, 'bad-host', 6379)).toContain(expected);
  });

  it('returns null for unknown or missing errors', () => {
    expect(describeConnectError({ code: 'EPIPE' }, 'h', 1)).toBeNull();
    expect(describeConnectError(null, 'h', 1)).toBeNull();
  });
});

describe('UnifiedDatabaseAdapter connect error text', () => {
  afterEach(() => jest.restoreAllMocks());

  // Mirrors iovalkey: the socket error goes to the 'error' event and connect()
  // rejects with a generic "Connection is closed.".
  function failConnect(socketError: Error | null, rejection: Error) {
    jest.spyOn(Valkey.prototype, 'connect').mockImplementation(function (this: Valkey) {
      if (socketError) this.emit('error', socketError);
      return Promise.reject(rejection);
    });
  }

  function adapter() {
    return new UnifiedDatabaseAdapter({ host: 'Fffhgddgbgf345544', port: 6379, username: '', password: '' });
  }

  it('replaces "Connection is closed." with the DNS cause', async () => {
    const dnsError = Object.assign(new Error('getaddrinfo ENOTFOUND Fffhgddgbgf345544'), {
      code: 'ENOTFOUND',
    });
    failConnect(dnsError, new Error('Connection is closed.'));

    await expect(adapter().connect()).rejects.toThrow(
      'Host "Fffhgddgbgf345544" could not be found. Check the hostname for typos.',
    );
  });

  it('keeps "Connection is closed." when no socket error explains it', async () => {
    failConnect(null, new Error('Connection is closed.'));
    await expect(adapter().connect()).rejects.toThrow('Connection is closed.');
  });

  it('passes other errors through unchanged', async () => {
    failConnect(
      Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' }),
      new Error('WRONGPASS invalid username-password pair'),
    );
    await expect(adapter().connect()).rejects.toThrow('WRONGPASS');
  });
});
