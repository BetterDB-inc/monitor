export type ClusterNodeState = 'healthy' | 'suspect' | 'failed';

const SUSPECT_FLAGS = ['fail?', 'handshake', 'noaddr'];

export function clusterNodeState(flags: readonly string[]): ClusterNodeState {
  if (flags.includes('fail')) return 'failed';
  if (flags.some((flag) => SUSPECT_FLAGS.includes(flag))) return 'suspect';
  return 'healthy';
}
