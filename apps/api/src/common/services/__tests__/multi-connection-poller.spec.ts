import { Logger } from '@nestjs/common';
import type { ConnectionStatus } from '@betterdb/shared';
import { ConnectionContext, MultiConnectionPoller } from '../multi-connection-poller';
import type { ConnectionRegistry } from '../../../connections/connection-registry.service';
import type { DatabasePort } from '../../interfaces/database-port.interface';

class TestPoller extends MultiConnectionPoller {
  protected readonly logger = new Logger('TestPoller');
  readonly polled: ConnectionContext[] = [];
  readonly removed: string[] = [];
  external = false;
  skipUnchanged = true;
  failNext = false;

  protected getIntervalMs(): number {
    return 1000;
  }

  protected async pollConnection(ctx: ConnectionContext): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('boom');
    }
    this.polled.push(ctx);
  }

  protected onConnectionRemoved(connectionId: string): void {
    this.removed.push(connectionId);
  }

  protected supportsExternalConnections(): boolean {
    return this.external;
  }

  protected skipUnchangedSamples(): boolean {
    return this.skipUnchanged;
  }

  tickNow(): Promise<void> {
    return (this as unknown as { tick(): Promise<void> }).tick();
  }
}

function status(id: string, connectionType: ConnectionStatus['connectionType']): ConnectionStatus {
  return { id, name: id, host: 'h', port: 6379, isConnected: true, connectionType } as ConnectionStatus;
}

function setup() {
  let statuses: ConnectionStatus[] = [status('d', 'direct'), status('e', 'external')];
  let version: number | null = 1;
  const clients: Record<string, Partial<DatabasePort>> = {
    d: {},
    e: { sampleVersion: () => version },
  };
  const registry = {
    list: () => statuses,
    get: (id: string) => clients[id],
  } as unknown as ConnectionRegistry;
  const poller = new TestPoller(registry);
  return {
    poller,
    setStatuses: (next: ConnectionStatus[]) => (statuses = next),
    setVersion: (next: number | null) => (version = next),
    polledIds: () => poller.polled.map((c) => c.connectionId),
  };
}

describe('MultiConnectionPoller external handling', () => {
  it('skips external connections unless the subclass opts in', async () => {
    const { poller, polledIds } = setup();
    await poller.tickNow();
    expect(polledIds()).toEqual(['d']);
    expect(poller.polled[0].connectionType).toBe('direct');
  });

  it('polls an opted-in external connection once per sample version', async () => {
    const { poller, polledIds, setVersion } = setup();
    poller.external = true;
    await poller.tickNow();
    await poller.tickNow();
    expect(polledIds()).toEqual(['d', 'e', 'd']);
    setVersion(2);
    await poller.tickNow();
    expect(polledIds()).toEqual(['d', 'e', 'd', 'd', 'e']);
    expect(poller.polled[1].connectionType).toBe('external');
  });

  it('polls every tick when skipUnchangedSamples is off', async () => {
    const { poller, polledIds } = setup();
    poller.external = true;
    poller.skipUnchanged = false;
    await poller.tickNow();
    await poller.tickNow();
    expect(polledIds().filter((id) => id === 'e')).toHaveLength(2);
  });

  it('never skips a null version', async () => {
    const { poller, polledIds, setVersion } = setup();
    poller.external = true;
    setVersion(null);
    await poller.tickNow();
    await poller.tickNow();
    expect(polledIds().filter((id) => id === 'e')).toHaveLength(2);
  });

  it('records the version only after a successful poll', async () => {
    const { poller, polledIds, setStatuses } = setup();
    poller.external = true;
    setStatuses([status('e', 'external')]);
    poller.failNext = true;
    await poller.tickNow();
    expect(polledIds()).toEqual([]);
    await poller.tickNow();
    expect(polledIds()).toEqual(['e']);
  });

  it('forgets the version when the connection is removed', async () => {
    const { poller, polledIds, setStatuses } = setup();
    poller.external = true;
    await poller.tickNow();
    setStatuses([status('d', 'direct')]);
    await poller.tickNow();
    expect(poller.removed).toEqual(['e']);
    setStatuses([status('d', 'direct'), status('e', 'external')]);
    await poller.tickNow();
    expect(polledIds().filter((id) => id === 'e')).toHaveLength(2);
  });
});
