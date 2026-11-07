import { AlertTriangle, Info } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import type { FanoutCoverage } from '@/types/anomaly';

const NOT_CHECKED =
  'Replication divergence, retry amplification and reshard skew are not evaluated on primaries that are not checked.';

/**
 * Notice shown when the per-node fan-out of the selected cluster or Sentinel
 * connection covers none, or only some, of its primaries. Nothing is rendered
 * while every primary is checked, or when the connection has no other
 * primaries to reach (standalone, every primary registered on its own, or
 * checked through another connection).
 */
export function FanoutCoverageNotice({ coverage }: { coverage: FanoutCoverage | null | undefined }) {
  if (!coverage) return null;

  if (coverage.reason === 'no_sentinel_credentials') {
    return (
      <Alert className="border-yellow-500 text-yellow-500">
        <AlertTriangle className="w-4 h-4" />
        <AlertTitle>Sentinel data nodes not covered</AlertTitle>
        <AlertDescription>
          <p>
            This connection has no data-node credentials, so none of the primaries the Sentinel
            monitors are checked. {NOT_CHECKED}
          </p>
          <p>
            Set <span className="font-medium">Data node credentials</span> (
            <code>nodeUsername</code> / <code>nodePassword</code>) when adding the Sentinel
            connection, or tick{' '}
            <span className="font-medium">Connect to data nodes without a username</span> and
            leave the password empty when the data nodes need no AUTH. Connections cannot be
            edited in place, so re-add this one with the credentials set.
          </p>
        </AlertDescription>
      </Alert>
    );
  }

  if (coverage.reason === 'ssh_tunnel') {
    return (
      <Alert className="border-yellow-500 text-yellow-500">
        <AlertTriangle className="w-4 h-4" />
        <AlertTitle>Sentinel data nodes not covered</AlertTitle>
        <AlertDescription>
          The primaries this Sentinel monitors sit behind its SSH tunnel and cannot be reached
          by the per-node checks. {NOT_CHECKED}
        </AlertDescription>
      </Alert>
    );
  }

  if (coverage.reason === 'topology_unknown') {
    return (
      <Alert>
        <Info className="w-4 h-4" />
        <AlertTitle>Other primaries not checked yet</AlertTitle>
        <AlertDescription>
          The topology has not been read: CLUSTER NODES failed, or SENTINEL MASTERS has not been
          polled yet. The per-node checks start once it is.
        </AlertDescription>
      </Alert>
    );
  }

  const { checked, unreachable, skipped } = coverage;
  if (coverage.reason !== null || unreachable + skipped === 0) return null;

  const total = checked + unreachable + skipped;
  const gaps = [
    unreachable > 0 ? `${unreachable} unreachable` : null,
    skipped > 0 ? `${skipped} past the 64-primary cap` : null,
  ].filter((gap): gap is string => gap !== null);

  return (
    <Alert className="border-yellow-500 text-yellow-500">
      <AlertTriangle className="w-4 h-4" />
      <AlertTitle>
        {checked} of {total} primaries checked ({gaps.join(', ')})
      </AlertTitle>
      <AlertDescription>
        {unreachable > 0 &&
          'Unreachable primaries are flagged down by the topology, in retry backoff, or did not answer INFO within 2 seconds. '}
        {skipped > 0 &&
          'Primaries past the cap are checked by no connection; register one of them as its own connection to cover the rest. '}
        {NOT_CHECKED}
      </AlertDescription>
    </Alert>
  );
}
