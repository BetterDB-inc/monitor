import type { ConnectionRegistry } from '../../connections/connection-registry.service';
import { AclChecker } from '../acl-checker';

function makeChecker({
  whoami,
  getuser,
}: {
  whoami: string | (() => Promise<string>);
  getuser: unknown | (() => Promise<unknown>);
}) {
  const call = jest.fn().mockImplementation((cmd: string, args: string[]) => {
    if (cmd === 'ACL' && args?.[0] === 'WHOAMI') {
      return typeof whoami === 'function' ? whoami() : Promise.resolve(whoami);
    }
    if (cmd === 'ACL' && args?.[0] === 'GETUSER') {
      return typeof getuser === 'function' ? getuser() : Promise.resolve(getuser);
    }
    return Promise.reject(new Error(`unexpected call ${cmd} ${(args ?? []).join(' ')}`));
  });

  const client = { call };
  const registry = { get: jest.fn().mockReturnValue(client) } as unknown as ConnectionRegistry;
  return { checker: new AclChecker(registry), call };
}

describe('AclChecker', () => {
  it('reports hasMonitor=true when commands include +monitor', async () => {
    const { checker } = makeChecker({
      whoami: 'default',
      getuser: ['flags', ['on'], 'commands', '+@read +monitor'],
    });
    const result = await checker.check('conn-1');
    expect(result).toMatchObject({ username: 'default', hasMonitor: true });
    expect(result.setUserSnippet).toBeUndefined();
  });

  it('reports hasMonitor=true for +@all without an explicit -monitor', async () => {
    const { checker } = makeChecker({
      whoami: 'admin',
      getuser: ['commands', '+@all'],
    });
    const result = await checker.check('conn-1');
    expect(result.hasMonitor).toBe(true);
  });

  it('reports hasMonitor=true for +@dangerous (which includes MONITOR)', async () => {
    const { checker } = makeChecker({
      whoami: 'ops',
      getuser: ['commands', '+@read +@dangerous'],
    });
    const result = await checker.check('conn-1');
    expect(result.hasMonitor).toBe(true);
  });

  it('reports hasMonitor=false when -monitor explicitly revokes it', async () => {
    const { checker } = makeChecker({
      whoami: 'ops',
      getuser: ['commands', '+@all -monitor'],
    });
    const result = await checker.check('conn-1');
    expect(result.hasMonitor).toBe(false);
    expect(result.setUserSnippet).toBe('ACL SETUSER ops +monitor');
  });

  it('reports hasMonitor=false when only narrow grants are present', async () => {
    const { checker } = makeChecker({
      whoami: 'reader',
      getuser: ['commands', '+@read +get +set'],
    });
    const result = await checker.check('conn-1');
    expect(result.hasMonitor).toBe(false);
    expect(result.setUserSnippet).toBe('ACL SETUSER reader +monitor');
  });

  it('handles RESP3-style object responses', async () => {
    const { checker } = makeChecker({
      whoami: 'default',
      getuser: { commands: '+@all', flags: ['on'] },
    });
    const result = await checker.check('conn-1');
    expect(result.hasMonitor).toBe(true);
  });

  it('returns hasMonitor=false with snippet when ACL GETUSER fails', async () => {
    const { checker } = makeChecker({
      whoami: 'default',
      getuser: () => Promise.reject(new Error('NOPERM cannot inspect ACL')),
    });
    const result = await checker.check('conn-1');
    expect(result).toMatchObject({
      username: 'default',
      hasMonitor: false,
      setUserSnippet: 'ACL SETUSER default +monitor',
    });
  });

  it('falls back to "default" username when ACL WHOAMI fails', async () => {
    const { checker } = makeChecker({
      whoami: () => Promise.reject(new Error('disconnected')),
      getuser: ['commands', '+@all'],
    });
    const result = await checker.check('conn-1');
    expect(result.username).toBe('default');
    expect(result.hasMonitor).toBe(true);
  });
});
