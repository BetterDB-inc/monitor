import { EventEmitter } from 'events';
import type { WebSocket } from 'ws';
import { AgentDatabaseAdapter } from './agent-database-adapter';
import { AgentReadOnlyError } from '../../apps/api/src/common/errors/agent-read-only.error';

class FakeSocket extends EventEmitter {
  readyState = 1;
  commands: Array<{ id: string; cmd: string; args: string[] }> = [];
  /** Reply for a command; defaults to an INFO-shaped section for the first arg. */
  reply: (command: { cmd: string; args: string[] }) => unknown = (command) => {
    const [section] = command.args;
    return `# ${section}\r\n${section}_field:1\r\n`;
  };

  send(payload: string): void {
    const command = JSON.parse(payload);
    this.commands.push(command);
    const data = this.reply(command);
    setImmediate(() => {
      this.emit('message', JSON.stringify({ id: command.id, type: 'response', data }));
    });
  }
}

describe('AgentDatabaseAdapter getInfo', () => {
  it('reads each requested section with its own INFO', async () => {
    const socket = new FakeSocket();
    const hello = { valkey: { type: 'valkey', version: '8.0.0' }, capabilities: [] };
    const adapter = new AgentDatabaseAdapter(socket as unknown as WebSocket, hello as never);

    const info = await adapter.getInfo(['memory', 'replication']);

    expect(socket.commands.map((c) => c.args)).toEqual([['memory'], ['replication']]);
    expect(info).toMatchObject({
      memory: { memory_field: '1' },
      replication: { replication_field: '1' },
    });
  });
});

describe('AgentDatabaseAdapter capabilities', () => {
  function slotStats(type: 'valkey' | 'redis', version: string, capabilities = ['CLUSTER']) {
    const hello = { valkey: { type, version }, capabilities };
    const adapter = new AgentDatabaseAdapter(new FakeSocket() as unknown as WebSocket, hello as never);
    return adapter.getCapabilities().hasClusterSlotStats;
  }

  it('gates CLUSTER SLOT-STATS on the server version, not on cluster mode alone', () => {
    expect(slotStats('valkey', '7.2.5')).toBe(false);
    expect(slotStats('valkey', '8.0.1')).toBe(true);
    expect(slotStats('valkey', '9.0.6')).toBe(true);
    expect(slotStats('redis', '7.2.4')).toBe(false);
    expect(slotStats('redis', '8.0.0')).toBe(false);
    expect(slotStats('redis', '8.2.1')).toBe(true);
    expect(slotStats('valkey', '9.0.6', [])).toBe(false);
  });
});

describe('AgentDatabaseAdapter read-only', () => {
  const identity = { platform: 'openeverest', cluster: 'main', namespace: 'db', instance: 'vk', node: 'n1' };

  function buildAdapter(readOnly: boolean) {
    const socket = new FakeSocket();
    const hello = { valkey: { type: 'valkey', version: '8.1.0' }, capabilities: ['COMMANDLOG'], readOnly, identity };
    return { socket, adapter: new AgentDatabaseAdapter(socket as unknown as WebSocket, hello as never) };
  }

  it('refuses the state-changing adapter methods without sending them to the agent', async () => {
    const { socket, adapter } = buildAdapter(true);

    await expect(adapter.resetSlowLog()).rejects.toThrow('read-only');
    await expect(adapter.resetCommandLog()).rejects.toThrow('read-only');
    await expect(adapter.resetLatencyEvents()).rejects.toThrow('read-only');
    await expect(adapter.resetAclLog()).rejects.toThrow('read-only');
    await expect(adapter.killClient({})).rejects.toThrow();

    expect(socket.commands).toHaveLength(0);
  });

  it('refuses CLIENT KILL with the typed read-only error, so the API answers 403', async () => {
    const { adapter } = buildAdapter(true);

    await expect(adapter.killClient({})).rejects.toBeInstanceOf(AgentReadOnlyError);
  });

  it('keeps the unsupported error for CLIENT KILL on writable agent connections', async () => {
    const { adapter } = buildAdapter(false);

    const err = await adapter.killClient({}).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(AgentReadOnlyError);
    expect((err as Error).message).toMatch(/not supported/);
  });

  it('redacts credential values in CONFIG GET replies, whatever pattern was asked for', async () => {
    const socket = new FakeSocket();
    socket.reply = () => ['requirepass', 'hunter2', 'maxmemory', '0', 'masterauth', 'hunter2', 'appendonly', 'no'];
    const hello = { valkey: { type: 'valkey', version: '8.1.0' }, capabilities: ['CONFIG'], readOnly: true, identity };
    const adapter = new AgentDatabaseAdapter(socket as unknown as WebSocket, hello as never);

    expect(await adapter.call('CONFIG', ['GET', '*'], { cli: true })).toEqual([
      'requirepass', '<redacted>', 'maxmemory', '0', 'masterauth', '<redacted>', 'appendonly', 'no',
    ]);
    expect(await adapter.call('config', ['get', 'requirepass'], { cli: true })).toEqual([
      'requirepass', '<redacted>', 'maxmemory', '0', 'masterauth', '<redacted>', 'appendonly', 'no',
    ]);
    expect(await adapter.getConfigValue('maxmemory')).toBe('0');
  });

  it('redacts password hashes from ACL LIST and ACL GETUSER on a read-only connection', async () => {
    const socket = new FakeSocket();
    const hash = 'c'.repeat(64);
    socket.reply = (command) => (command.args[0].toUpperCase() === 'LIST'
      ? [`user default on #${hash} ~* &* +@all`, 'user ro on nopass ~* +@read']
      : ['flags', ['on'], 'passwords', [hash], 'keys', '~*']);
    const hello = { valkey: { type: 'valkey', version: '8.1.0' }, capabilities: ['ACL'], readOnly: true, identity };
    const adapter = new AgentDatabaseAdapter(socket as unknown as WebSocket, hello as never);

    expect(await adapter.getAclList()).toEqual(['user default on #<redacted> ~* &* +@all', 'user ro on nopass ~* +@read']);
    expect(await adapter.call('acl', ['list'], { cli: true })).toEqual(['user default on #<redacted> ~* &* +@all', 'user ro on nopass ~* +@read']);
    // GETUSER is outside the read-only allowlist altogether.
    await expect(adapter.call('ACL', ['GETUSER', 'default'], { cli: true })).rejects.toThrow('read-only');
  });

  it('leaves CONFIG GET replies alone when the agent did not ask for read-only', async () => {
    const socket = new FakeSocket();
    socket.reply = () => ['requirepass', 'hunter2'];
    const hello = { valkey: { type: 'valkey', version: '8.1.0' }, capabilities: ['CONFIG'], readOnly: false };
    const adapter = new AgentDatabaseAdapter(socket as unknown as WebSocket, hello as never);

    expect(await adapter.call('CONFIG', ['GET', 'requirepass'], { cli: true })).toEqual(['requirepass', 'hunter2']);
  });

  it('refuses CLIENT KILL and CONFIG SET sent through call(), as the CLI does', async () => {
    const { socket, adapter } = buildAdapter(true);

    await expect(adapter.call('CLIENT', ['KILL', 'ID', '7'], { cli: true })).rejects.toThrow('read-only');
    await expect(adapter.call('config', ['set', 'maxmemory', '0'], { cli: true })).rejects.toThrow('read-only');
    await expect(adapter.call('FLUSHALL', [], { cli: true })).rejects.toThrow('read-only');

    expect(socket.commands).toHaveLength(0);
  });

  it('still forwards reads on a read-only connection', async () => {
    const { socket, adapter } = buildAdapter(true);

    await adapter.getInfo(['server']);
    await adapter.getSlowLogLength().catch(() => undefined);

    expect(socket.commands.map((c) => c.cmd)).toEqual(['INFO', 'SLOWLOG']);
  });

  it('forwards the RESET sub-commands when the agent did not ask for read-only', async () => {
    const { socket, adapter } = buildAdapter(false);

    await adapter.resetSlowLog();

    expect(socket.commands.map((c) => [c.cmd, ...c.args])).toEqual([['SLOWLOG', 'RESET']]);
  });
});
