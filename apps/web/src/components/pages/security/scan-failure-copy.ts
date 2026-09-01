import { MISSING_CONNECTION_MESSAGE, type FailedNode } from './scan-error';

export interface ScanFailureCopy {
  headline: string;
  detail: string;
  guidance: string;
}

const INSTANCE_GUIDANCE =
  'Check the instance is running and reachable from the monitor, and that this connection’s credentials still authenticate. A scan reads INFO and MODULE LIST from the instance itself.';

const CLUSTER_GUIDANCE =
  'Nodes are reached at the addresses the cluster advertises. If those are container-internal, the monitor cannot route to them from outside.';

const BLANK_DETAIL =
  'The instance never answered, so no engine version was read and nothing was matched. This is not an all-clear — it is a blank.';

export function scanFailureCopy(summary: string, nodes: FailedNode[]): ScanFailureCopy {
  if (summary === MISSING_CONNECTION_MESSAGE) {
    return {
      headline: 'This connection no longer exists',
      detail: 'It was removed while this page was open, so there was nothing left to scan.',
      guidance: 'Pick another connection from the selector at the top of the sidebar.',
    };
  }

  if (nodes.length > 1) {
    return {
      headline: 'No node in this cluster could be scanned',
      detail: `${nodes.length} nodes were discovered and none answered. A cluster is only as scanned as its nodes — nothing here is an all-clear.`,
      guidance: CLUSTER_GUIDANCE,
    };
  }

  return {
    headline: 'This connection could not be scanned',
    detail: BLANK_DETAIL,
    guidance: INSTANCE_GUIDANCE,
  };
}
