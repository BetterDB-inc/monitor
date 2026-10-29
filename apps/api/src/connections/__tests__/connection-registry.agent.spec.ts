jest.mock('../../database/adapters/unified.adapter');

import { ConnectionRegistry } from '../connection-registry.service';
import { ExternalMetricsStore } from '../../external-metrics/external-metrics-store';
import { DiscoveredInstancesStore } from '../../external-metrics/discovered-instances.store';

function build() {
  const storage = {
    saveConnection: jest.fn().mockResolvedValue(undefined),
    deleteConnection: jest.fn().mockResolvedValue(undefined),
    updateConnection: jest.fn().mockResolvedValue(undefined),
    getConnections: jest.fn().mockResolvedValue([]),
  };
  const tracker = {
    removeConnection: jest.fn(),
    getCapabilities: jest.fn().mockReturnValue(null),
  };
  return new ConnectionRegistry(
    storage as never,
    {} as never,
    tracker as never,
    {} as never,
    new ExternalMetricsStore(),
    undefined,
    new DiscoveredInstancesStore(true),
  );
}

describe('ConnectionRegistry agent connections', () => {
  it('remembers that an agent reported an ElastiCache Serverless target', async () => {
    const registry = build();
    await registry.registerAgentConnection('agent-1', 'Agent', {} as never, { serverless: true });
    expect(registry.isServerlessAgentConnection('agent-1')).toBe(true);
  });

  it('treats an agent without the flag as not serverless', async () => {
    const registry = build();
    await registry.registerAgentConnection('agent-1', 'Agent', {} as never);
    expect(registry.isServerlessAgentConnection('agent-1')).toBe(false);
  });

  it('forgets the flag when the agent disconnects', async () => {
    const registry = build();
    await registry.registerAgentConnection('agent-1', 'Agent', {} as never, { serverless: true });
    registry.removeAgentConnection('agent-1');
    expect(registry.isServerlessAgentConnection('agent-1')).toBe(false);
  });
});
