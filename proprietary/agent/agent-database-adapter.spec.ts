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
