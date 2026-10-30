import { EventEmitter } from 'events';
import type Valkey from 'iovalkey';
import { createIovalkeyMonitorSource } from '../iovalkey-monitor-source';

class FakeMonitorClient extends EventEmitter {
  disconnect = jest.fn();
}

function makeClient(): { client: Valkey; monitor: FakeMonitorClient; duplicate: jest.Mock } {
  const monitor = new FakeMonitorClient();
  const duplicate = jest.fn().mockReturnValue(monitor);
  return { client: { duplicate } as unknown as Valkey, monitor, duplicate };
}

describe('createIovalkeyMonitorSource', () => {
  afterEach(() => jest.useRealTimers());

  it('duplicates the client in monitor mode and resolves once monitoring starts', async () => {
    const { client, monitor, duplicate } = makeClient();
    const opening = createIovalkeyMonitorSource(client, 1_000);
    monitor.emit('monitoring');
    const source = await opening;

    expect(duplicate).toHaveBeenCalledWith({ monitor: true, lazyConnect: false });
    expect(monitor.disconnect).not.toHaveBeenCalled();

    const lines: string[] = [];
    source.on('line', (line) => lines.push(line));
    monitor.emit('monitor', '1700000000.1', ['GET', 'k'], '1.2.3.4:5', 0);
    expect(lines).toEqual(['1700000000.1 [0 1.2.3.4:5] "GET" "k"']);

    source.stop();
    expect(monitor.disconnect).toHaveBeenCalledTimes(1);
  });

  it('rejects after the timeout and disconnects the duplicate when MONITOR never opens', async () => {
    jest.useFakeTimers();
    const { client, monitor } = makeClient();
    const opening = createIovalkeyMonitorSource(client, 500);
    const failure = expect(opening).rejects.toThrow('MONITOR open timed out after 500 ms');

    await jest.advanceTimersByTimeAsync(500);
    await failure;

    expect(monitor.disconnect).toHaveBeenCalledTimes(1);
    // A late error from the abandoned connection must not be unhandled.
    expect(() => monitor.emit('error', new Error('late'))).not.toThrow();
  });

  it('disconnects the duplicate when the open fails with an error', async () => {
    const { client, monitor } = makeClient();
    const opening = createIovalkeyMonitorSource(client, 1_000);
    monitor.emit('error', new Error('connect ECONNREFUSED'));

    await expect(opening).rejects.toThrow('ECONNREFUSED');
    expect(monitor.disconnect).toHaveBeenCalledTimes(1);
  });

  it('forwards runtime errors after a successful open', async () => {
    const { client, monitor } = makeClient();
    const opening = createIovalkeyMonitorSource(client, 1_000);
    monitor.emit('monitoring');
    const source = await opening;

    const errors: Error[] = [];
    source.on('error', (err) => errors.push(err));
    monitor.emit('error', new Error('socket closed'));
    expect(errors.map((e) => e.message)).toEqual(['socket closed']);
  });
});
