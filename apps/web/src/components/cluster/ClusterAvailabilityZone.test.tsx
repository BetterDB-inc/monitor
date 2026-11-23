import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ClusterNode } from '../../types/metrics';
import { ClusterNodesTable } from './ClusterNodesTable';
import { ClusterTopology } from './ClusterTopology';

const shardId = '7c9e1b0f5a3d4e6f8a2b1c0d9e8f7a6b5c4d3e2f';

function clusterNode(overrides: Partial<ClusterNode>): ClusterNode {
  return {
    id: 'e2e5e98c4e177833752687117b54cbeefe174953',
    address: '10.0.0.1:6379',
    flags: ['master'],
    master: '-',
    pingSent: 0,
    pongReceived: 0,
    configEpoch: 1,
    linkState: 'connected',
    slots: [[0, 16383]],
    ...overrides,
  };
}

const primary = clusterNode({ availabilityZone: 'us-east-1a', shardId });
const replica = clusterNode({
  id: '331427a0134bc2e6047d0ad132933abbb8a7b6a4',
  address: '10.0.0.2:6379',
  flags: ['slave'],
  master: primary.id,
  slots: [],
  shardId,
});
const withoutZones = [clusterNode({}), clusterNode({ id: 'b'.repeat(40), address: '10.0.0.3:6379' })];

describe('ClusterNodesTable availability zone', () => {
  it('shows a zone column with each node zone when any node reports one', () => {
    render(<ClusterNodesTable nodes={[primary, replica]} />);

    expect(screen.getByRole('columnheader', { name: 'Zone' })).toBeInTheDocument();
    expect(screen.getByText('us-east-1a')).toBeInTheDocument();
  });

  it('hides the zone column when no node reports a zone', () => {
    render(<ClusterNodesTable nodes={withoutZones} />);

    expect(screen.queryByRole('columnheader', { name: 'Zone' })).not.toBeInTheDocument();
  });

  it('shows the shard id in the expanded row', () => {
    render(<ClusterNodesTable nodes={[primary]} />);

    fireEvent.click(screen.getByText(primary.address));

    expect(screen.getByText('Shard ID:')).toBeInTheDocument();
    expect(screen.getByText(shardId)).toBeInTheDocument();
  });
});

describe('ClusterTopology availability zone', () => {
  it('shows the zone on the cards of nodes that report one', () => {
    render(<ClusterTopology nodes={[primary, replica]} />);

    expect(screen.getAllByText('us-east-1a')).toHaveLength(1);
    expect(screen.getAllByText('Zone:')).toHaveLength(1);
  });

  it('shows no zone line when no node reports a zone', () => {
    render(<ClusterTopology nodes={withoutZones} />);

    expect(screen.queryByText('Zone:')).not.toBeInTheDocument();
  });
});
