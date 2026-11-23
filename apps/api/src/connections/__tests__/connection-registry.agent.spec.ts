jest.mock('../../database/adapters/unified.adapter');

import { ConnectionRegistry } from '../connection-registry.service';
import { ExternalMetricsStore } from '../../external-metrics/external-metrics-store';
import { DiscoveredInstancesStore } from '../../external-metrics/discovered-instances.store';
import { RuntimeCapabilityTracker } from '../runtime-capability-tracker.service';

function build(capabilityTracker?: RuntimeCapabilityTracker) {
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
    (capabilityTracker ?? tracker) as never,
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

  it('starts a reconnected agent without the node id or outside-cluster mark of its last session', async () => {
    const registry = build();
    await registry.registerAgentConnection('agent-1', 'Agent', {} as never);
    registry.noteObservedNodeId('agent-1', 'node-a');
    registry.noteOutsideCluster('agent-1', true);

    await registry.registerAgentConnection('agent-1', 'Agent', {} as never);

    expect(registry.getObservedNodeId('agent-1')).toBeUndefined();
    expect(registry.isOutsideCluster('agent-1')).toBe(false);
  });

  it('starts a reconnected agent with its runtime capabilities re-enabled', async () => {
    const tracker = new RuntimeCapabilityTracker();
    const registry = build(tracker);
    await registry.registerAgentConnection('agent-1', 'Agent', {} as never);
    tracker.recordFailure('agent-1', 'canSlowLog', 'NOPERM this user has no permissions');
    expect(tracker.isAvailable('agent-1', 'canSlowLog')).toBe(false);

    await registry.registerAgentConnection('agent-1', 'Agent', {} as never);

    expect(tracker.isAvailable('agent-1', 'canSlowLog')).toBe(true);
  });
});
