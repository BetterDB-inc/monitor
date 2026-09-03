import {
  CVE_DISABLED_MESSAGE,
  DATASET_UNAVAILABLE_MESSAGE,
  MISSING_CONNECTION_MESSAGE,
  type FailedNode,
} from './scan-error';

export interface ScanFailureCopy {
  headline: string;
  detail: string;
  guidance: string;
  connectionAtFault: boolean;
}

const INSTANCE_GUIDANCE =
  'Check the instance is running and reachable from the monitor, and that this connection’s credentials still authenticate. A scan reads INFO and MODULE LIST from the instance itself.';

const CLUSTER_GUIDANCE =
  'Nodes are reached at the addresses the cluster advertises. If those are container-internal, the monitor cannot route to them from outside.';

const DATASET_GUIDANCE =
  'The monitor fetches advisories from GHSA, NVD, MITRE, KEV and EPSS. Check outbound network access to those feeds, then refresh the dataset from Settings.';

const DISABLED_GUIDANCE =
  'Set CVE_ENABLED=true and restart the monitor to fetch advisories and scan again. It is off by default on egress restricted installs.';

const UNKNOWN_GUIDANCE =
  'The message above is what the server reported. Retry, and if it keeps failing check the monitor logs for the request that failed.';

const BLANK_DETAIL =
  'The instance never answered, so no engine version was read and nothing was matched. This is not an all-clear — it is a blank.';

export function scanFailureCopy(summary: string, nodes: FailedNode[]): ScanFailureCopy {
  if (summary === MISSING_CONNECTION_MESSAGE) {
    return {
      headline: 'This connection no longer exists',
      detail: 'It was removed while this page was open, so there was nothing left to scan.',
      guidance: 'Pick another connection from the selector at the top of the sidebar.',
      connectionAtFault: true,
    };
  }

  if (summary.startsWith(DATASET_UNAVAILABLE_MESSAGE)) {
    return {
      headline: 'There is no advisory corpus to scan against',
      detail:
        'The instance was never matched, because the monitor has not fetched any advisories yet. Nothing here says this instance is clean — it says nothing at all.',
      guidance: DATASET_GUIDANCE,
      connectionAtFault: false,
    };
  }

  if (summary.startsWith(CVE_DISABLED_MESSAGE)) {
    return {
      headline: 'CVE inspection is turned off here',
      detail:
        'Nothing was fetched and nothing was matched, because this install has CVE inspection disabled. This screen is a blank, not an all-clear.',
      guidance: DISABLED_GUIDANCE,
      connectionAtFault: false,
    };
  }

  if (nodes.length > 1) {
    return {
      headline: 'No node in this cluster could be scanned',
      detail: `${nodes.length} nodes were discovered and none answered. A cluster is only as scanned as its nodes — nothing here is an all-clear.`,
      guidance: CLUSTER_GUIDANCE,
      connectionAtFault: true,
    };
  }

  if (nodes.length === 0) {
    return {
      headline: 'This scan did not complete',
      detail:
        'The monitor could not finish a scan for this connection, so no version was matched against anything. This is not an all-clear — it is a blank.',
      guidance: UNKNOWN_GUIDANCE,
      connectionAtFault: false,
    };
  }

  return {
    headline: 'This connection could not be scanned',
    detail: BLANK_DETAIL,
    guidance: INSTANCE_GUIDANCE,
    connectionAtFault: true,
  };
}
