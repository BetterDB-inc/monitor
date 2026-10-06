import Valkey from 'iovalkey';
import { UnifiedDatabaseAdapter } from '../unified.adapter';

jest.mock('iovalkey');

function createMockClient(clusterInfo: () => Promise<string>) {
  return {
    options: { host: 'localhost', port: 6379 },
    status: 'ready',
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    quit: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn(),
    config: jest.fn().mockResolvedValue(['maxmemory', '0']),
    call: jest.fn().mockRejectedValue(new Error('unknown command')),
    info: jest.fn((section?: string) => {
      if (section === 'server') {
        return Promise.resolve('# Server\r\nredis_version:7.2.0\r\n');
      }
      if (section === 'cluster') {
        return clusterInfo();
      }
      return Promise.resolve('');
    }),
  };
}

function makeAdapter(clusterInfo: () => Promise<string>) {
  const mockClient = createMockClient(clusterInfo);
  jest.mocked(Valkey).mockImplementation(() => mockClient as unknown as Valkey);
  return new UnifiedDatabaseAdapter({
    host: 'localhost',
    port: 6379,
    username: '',
    password: '',
  });
}

describe('UnifiedDatabaseAdapter cluster capability detection', () => {
  it.each([
    ['cluster_enabled:1', true],
    ['cluster_enabled:0', false],
  ])('detects %s as clusterEnabled=%s', async (line, expected) => {
    const adapter = makeAdapter(() => Promise.resolve(`# Cluster\r\n${line}\r\n`));

    await adapter.connect();

    expect(adapter.getCapabilities().clusterEnabled).toBe(expected);
  });

  it('leaves clusterEnabled false when INFO cluster fails', async () => {
    const adapter = makeAdapter(() => Promise.reject(new Error('cluster info unavailable')));

    await adapter.connect();

    expect(adapter.getCapabilities().clusterEnabled).toBe(false);
  });
});
