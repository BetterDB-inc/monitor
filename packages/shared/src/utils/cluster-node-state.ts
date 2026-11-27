export type ClusterNodeState = 'healthy' | 'suspect' | 'failed';

const SUSPECT_FLAGS = ['fail?', 'handshake', 'noaddr'];

export function clusterNodeState(flags: readonly string[]): ClusterNodeState {
  if (flags.includes('fail')) return 'failed';
  if (flags.some((flag) => SUSPECT_FLAGS.includes(flag))) return 'suspect';
  return 'healthy';
}

export function primaryIdOf(node: { id: string; master: string }): string {
  return node.master && node.master !== '-' ? node.master : node.id;
}
