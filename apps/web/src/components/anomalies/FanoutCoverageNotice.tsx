import type { ReactNode } from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.tsx';
import type { FanoutCoverage } from '@/types/anomaly';
import { useNow } from '@/hooks/useNow';

const NOT_CHECKED =
  'Replication divergence, retry amplification and reshard skew are not evaluated on primaries that are not checked.';

/** Coverage older than this gets its age shown, so a stalled poll does not read as current. */
const SHOW_AGE_AFTER_MS = 15_000;

// Two connections at one address report under the same Prometheus label, so a
// re-added connection must replace the old one rather than sit beside it.
const READD =
  'Connections cannot be edited in place: add the Sentinel again with the credentials set, then delete this connection so the two do not report under the same address.';

function primaries(count: number): string {
  return `${count} ${count === 1 ? 'primary' : 'primaries'}`;
}

function Notice({
  coverage,
  title,
  info = false,
  children,
}: {
  coverage: FanoutCoverage;
  title: string;
  info?: boolean;
  children: ReactNode;
}) {
  const age = useNow(true, 5_000) - coverage.timestamp;
  return (
    <Alert className={info ? undefined : 'border-yellow-500 text-yellow-500'}>
      {info ? <Info className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        {children}
        {age > SHOW_AGE_AFTER_MS && (
          <p className="text-muted-foreground">Last checked {Math.round(age / 1000)} seconds ago.</p>
        )}
      </AlertDescription>
    </Alert>
  );
}

/**
 * Notice shown when the per-node fan-out of the selected cluster or Sentinel
 * connection covers none, or only some, of its primaries. Nothing is rendered
 * while every primary is checked, or when the connection has no other
 * primaries to reach (standalone, every primary registered on its own, or
 * checked through another connection).
 */
export function FanoutCoverageNotice({ coverage }: { coverage: FanoutCoverage | null | undefined }) {
  if (!coverage) return null;

  const sentinel = coverage.topology === 'sentinel';
  const notCovered = sentinel ? 'Sentinel data nodes not covered' : 'Other primaries not covered';
  const none = coverage.notDialed > 0 ? `none of the ${primaries(coverage.notDialed)}` : 'none of the primaries';
  const reported = sentinel ? 'the Sentinel monitors' : 'the cluster reports';

  switch (coverage.reason) {
    case 'no_sentinel_credentials':
      return (
        <Notice coverage={coverage} title={notCovered}>
          <p>
            This connection has no data-node credentials, so {none} {reported} are checked. {NOT_CHECKED}
          </p>
          <p>
            Set <span className="font-medium">Data node credentials</span> (
            <code>nodeUsername</code> / <code>nodePassword</code>) when adding the Sentinel
            connection, or tick{' '}
            <span className="font-medium">Connect to data nodes without a username</span> and
            leave the password empty when the data nodes need no AUTH. {READD}
          </p>
        </Notice>
      );
    case 'sentinel_credentials_unreadable':
      return (
        <Notice coverage={coverage} title={notCovered}>
          <p>
            The data-node password is stored but could not be decrypted, so {none} {reported} are
            checked. {NOT_CHECKED}
          </p>
          <p>
            Start the monitor with the <code>ENCRYPTION_KEY</code> the connection was saved with. If
            that key is lost, add the Sentinel again with its data-node credentials and delete this
            connection.
          </p>
        </Notice>
      );
    case 'certificate_auth':
      return (
        <Notice coverage={coverage} title={notCovered}>
          <p>
            This Sentinel uses certificate auth, and the connection form stores no data-node
            settings in that mode, so {none} {reported} are checked. {NOT_CHECKED}
          </p>
          <p>
            Add the connection through <code>POST /api/connections</code> with{' '}
            <code>"nodeUsername": ""</code> to check the data nodes with the client certificate, or
            with <code>nodeUsername</code> / <code>nodePassword</code> for AUTH, then delete this
            connection so the two do not report under the same address.
          </p>
        </Notice>
      );
    case 'agent_connection':
      return (
        <Notice coverage={coverage} title={notCovered}>
          This connection is reached through the agent, and the monitor cannot dial the data nodes
          itself, so {none} {reported} are checked. {NOT_CHECKED} Register the primaries as their
          own agent connections to check them.
        </Notice>
      );
    case 'ssh_tunnel':
      return (
        <Notice coverage={coverage} title={notCovered}>
          The primaries {reported} sit behind its SSH tunnel and cannot be reached by the per-node
          checks, so {none} are checked. {NOT_CHECKED} Register the primaries as their own
          connections, each through its own tunnel, to check them.
        </Notice>
      );
    case 'topology_unknown':
      return (
        <Notice coverage={coverage} title="Other primaries not checked yet" info>
          SENTINEL MASTERS has not been read yet. The per-node checks start once it is.
        </Notice>
      );
    case 'topology_unreadable':
      return (
        <Notice coverage={coverage} title={notCovered}>
          {sentinel ? 'SENTINEL MASTERS' : 'CLUSTER NODES'} failed on the latest poll, so the
          primaries to check are not known. {NOT_CHECKED} If it keeps failing, check that the
          monitor's ACL user may run it.
        </Notice>
      );
    case null:
      break;
    default:
      return null;
  }

  const { checked, unreachable, authFailed, skipped, targetLimit, timeoutMs } = coverage;
  if (unreachable + authFailed + skipped === 0) return null;

  const total = checked + unreachable + authFailed + skipped;
  const gaps = [
    unreachable > 0 ? `${unreachable} unreachable` : null,
    authFailed > 0 ? `${authFailed} refused the credentials` : null,
    skipped > 0 ? `${skipped} past the ${targetLimit}-primary cap` : null,
  ].filter((gap): gap is string => gap !== null);

  return (
    <Notice coverage={coverage} title={`${checked} of ${total} primaries checked (${gaps.join(', ')})`}>
      {unreachable > 0 &&
        `Unreachable primaries are flagged down by the topology, in retry backoff, or did not answer within ${timeoutMs / 1000} seconds. `}
      {authFailed > 0 &&
        `Primaries that refused the credentials answered WRONGPASS, NOAUTH or NOPERM: check the ${sentinel ? 'data-node credentials' : 'connection username and password'} and the ACL user's permissions on those nodes. `}
      {skipped > 0 &&
        (sentinel
          ? `Primaries past the cap are checked by no connection; add another Sentinel of this deployment as a connection, with the same data-node credentials, to cover them: each connection checks up to ${targetLimit} primaries no other connection holds. `
          : `Primaries past the cap are checked by no connection; register one of them as its own connection to cover the rest: each connection checks up to ${targetLimit} primaries no other connection holds. `)}
      {NOT_CHECKED}
    </Notice>
  );
}
