import { describe, expect, it } from 'vitest';
import {
  CLUSTER_NODE_PARAM,
  CLUSTER_NODES_TAB,
  CLUSTER_TAB_PARAM,
  clusterNodePath,
  clusterNodeUrl,
} from '@betterdb/shared';
import { CONNECTION_PARAM } from '../../lib/connectionParam';

describe('clusterNodePath', () => {
  it('opens the nodes tab of the cluster page on the node', () => {
    const url = new URL(clusterNodePath('node a', 'conn 1'), 'http://x');

    expect(url.pathname).toBe('/cluster');
    expect(url.searchParams.get(CLUSTER_TAB_PARAM)).toBe(CLUSTER_NODES_TAB);
    expect(url.searchParams.get(CLUSTER_NODE_PARAM)).toBe('node a');
    expect(url.searchParams.get(CONNECTION_PARAM)).toBe('conn 1');
  });

  it('leaves the connection out when there is none', () => {
    expect(clusterNodePath('abc')).toBe('/cluster?tab=nodes&node=abc');
  });
});

describe('clusterNodeUrl', () => {
  it('joins the base URL and the node path', () => {
    expect(clusterNodeUrl('https://m.example.com', 'abc', 'conn-1')).toBe(
      'https://m.example.com/cluster?tab=nodes&node=abc&connection=conn-1',
    );
  });

  it('drops a trailing slash and keeps a path prefix of the base URL', () => {
    expect(clusterNodeUrl('https://m.example.com/monitor/', 'abc')).toBe(
      'https://m.example.com/monitor/cluster?tab=nodes&node=abc',
    );
  });
});
