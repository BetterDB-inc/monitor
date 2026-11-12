import type { DatabaseConnectionConfig } from '@betterdb/shared';

/**
 * Whether the monitor can open its own sockets to the nodes a connection's
 * topology reports. An agent connection reaches only its seed, through the
 * agent, and an external one has no socket at all. SSH-tunnelled connections
 * still dial: their CLUSTER NODES addresses are often reachable directly, and
 * a failed read says so.
 */
export function dialsDataNodes(
  config: Pick<DatabaseConnectionConfig, 'host' | 'connectionType'> | null | undefined,
): boolean {
  return config?.host !== 'agent' && config?.connectionType !== 'external';
}
