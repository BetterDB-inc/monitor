import { EventEmitter } from 'events';
import type { WebSocket } from 'ws';
import { AgentDatabaseAdapter } from './agent-database-adapter';

class FakeSocket extends EventEmitter {
  readyState = 1;
  commands: Array<{ id: string; cmd: string; args: string[] }> = [];

  send(payload: string): void {
    const command = JSON.parse(payload);
    this.commands.push(command);
    const [section] = command.args;
    const data = `# ${section}\r\n${section}_field:1\r\n`;
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
    expect(adapter.isReadOnly()).toBe(true);
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
    expect(adapter.isReadOnly()).toBe(false);
  });
});
