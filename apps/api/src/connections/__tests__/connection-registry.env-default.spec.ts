jest.mock('../../database/adapters/unified.adapter');

import { Logger } from '@nestjs/common';
import { ConnectionRegistry } from '../connection-registry.service';
import { UnifiedDatabaseAdapter } from '../../database/adapters/unified.adapter';
import { ExternalMetricsStore } from '../../external-metrics/external-metrics-store';

function build() {
  const storage = {
    saveConnection: jest.fn().mockResolvedValue(undefined),
    getConnections: jest.fn().mockResolvedValue([]),
  };
  const tracker = { removeConnection: jest.fn(), resetConnection: jest.fn(), getCapabilities: jest.fn() };
  const config = {
    get: jest.fn((key: string) =>
      key === 'database' ? { host: process.env.DB_HOST || 'localhost', port: 6379 } : undefined,
    ),
  };
  const registry = new ConnectionRegistry(
    storage as never,
    config as never,
    tracker as never,
    {} as never,
    new ExternalMetricsStore(),
  );
  return { registry, storage };
}

const loadConnections = (registry: ConnectionRegistry) =>
  (registry as unknown as { loadConnections: () => Promise<void> }).loadConnections();

describe('ConnectionRegistry env default connection', () => {
  const original = process.env.DB_HOST;

  beforeEach(() => {
    jest.mocked(UnifiedDatabaseAdapter).mockClear();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    if (original === undefined) delete process.env.DB_HOST;
    else process.env.DB_HOST = original;
    jest.restoreAllMocks();
  });

  it('waits for UI setup instead of connecting when DB_HOST is unset', async () => {
    delete process.env.DB_HOST;
    const { registry, storage } = build();
    await loadConnections(registry);
    expect(UnifiedDatabaseAdapter).not.toHaveBeenCalled();
    expect(storage.saveConnection).not.toHaveBeenCalled();
    expect(registry.getStartupConnectionErrors()).toEqual([]);
  });

  it('connects to a loopback DB_HOST the operator set', async () => {
    process.env.DB_HOST = 'localhost';
    jest
      .mocked(UnifiedDatabaseAdapter)
      .mockImplementation(() => ({ connect: jest.fn().mockRejectedValue(new Error('refused')) }) as never);
    const { registry } = build();
    await loadConnections(registry);
    expect(UnifiedDatabaseAdapter).toHaveBeenCalledWith(expect.objectContaining({ host: 'localhost' }));
    expect(registry.getStartupConnectionErrors()).toEqual([
      expect.objectContaining({ host: 'localhost', error: 'refused' }),
    ]);
  });
});
