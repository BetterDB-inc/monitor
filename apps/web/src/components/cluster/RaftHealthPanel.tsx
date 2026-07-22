import { Card, CardHeader, CardTitle, CardContent } from '../ui/card';
import { Badge } from '../ui/badge';
import { Crown, Users, Vote, CheckCircle, XCircle, AlertTriangle, GitCommitHorizontal } from 'lucide-react';
import { parseRaftInfo, RAFT_SEEKING_ROLES } from './raft-info';

const ROLE_CONFIG: Record<string, { icon: typeof Crown; color: string; bg: string; label: string }> = {
  leader: { icon: Crown, color: 'text-green-500', bg: 'bg-green-500/10', label: 'Leader' },
  follower: { icon: Users, color: 'text-primary', bg: 'bg-primary/10', label: 'Follower' },
  candidate: { icon: Vote, color: 'text-yellow-500', bg: 'bg-yellow-500/10', label: 'Candidate' },
  'pre-candidate': { icon: Vote, color: 'text-yellow-500', bg: 'bg-yellow-500/10', label: 'Pre-candidate' },
  joiner: { icon: Users, color: 'text-muted-foreground', bg: 'bg-muted', label: 'Joiner' },
};

/**
 * Cluster V2 (Raft) health panel. Shows the connected node's Raft role, term and
 * replicated-log progress. Renders nothing in legacy gossip mode. See the
 * upstream Cluster V2 work (`cluster-protocol raft`).
 *
 * `outageActive` comes from the backend's authoritative, time-based quorum-loss
 * detector (an active `raft_health` CRITICAL event). Because the outage role
 * flaps `follower`↔`pre-candidate`, a single 30s snapshot can momentarily catch a
 * healthy-looking `follower`; when the detector says an outage is active we show
 * it regardless, so the card can't flip to a green OK mid-incident.
 */
export function RaftHealthPanel({
  clusterInfo,
  outageActive = false,
}: {
  clusterInfo: Record<string, string> | null | undefined;
  outageActive?: boolean;
}) {
  const raft = parseRaftInfo(clusterInfo);
  if (!raft) return null;

  const roleConfig = ROLE_CONFIG[raft.role] ?? {
    icon: Users,
    color: 'text-muted-foreground',
    bg: 'bg-muted',
    label: raft.role || 'Unknown',
  };
  const RoleIcon = roleConfig.icon;

  // `cluster_state` is NOT a reliable health signal on its own: a surviving
  // replica keeps reporting `ok` through a majority outage, and `cluster_state:fail`
  // can mean unbound/unserved slots regardless of whether quorum is intact — any
  // node role (follower, joiner, leader) can see `fail` while a leader is elected.
  // So the only trustworthy "no quorum" signal is the backend detector's outage;
  // `cluster_state:fail` on its own is a slot/serving problem, not quorum loss. So:
  //   - a detected outage (backend `outageActive`) → "no quorum"
  //   - `cluster_state:fail` (any role) → a slot/serving problem
  //   - seeking a leader (candidate/pre-candidate) → "Electing" (no leader now)
  //   - otherwise → OK
  const status: 'ok' | 'electing' | 'fail-slots' | 'no-quorum' = outageActive
    ? 'no-quorum'
    : raft.clusterState === 'fail'
      ? 'fail-slots'
      : RAFT_SEEKING_ROLES.includes(raft.role)
        ? 'electing'
        : 'ok';
  const border =
    status === 'no-quorum' || status === 'fail-slots'
      ? 'border-destructive'
      : status === 'electing'
        ? 'border-yellow-500'
        : '';

  // Applied trailing far behind the committed index means this node is still
  // catching up (or wedged), so surface the gap rather than a single number.
  const applyLag = raft.commitIndex - raft.lastApplied;

  return (
    <Card className={border}>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center justify-between">
          <span className="flex items-center gap-2">
            <RoleIcon className={`w-5 h-5 ${roleConfig.color}`} />
            Cluster V2 · Raft Health
          </span>
          <Badge variant="outline" className="text-xs font-normal">
            Raft consensus
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Cluster state + this node's role */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">State:</span>
          {status === 'ok' && (
            <Badge className="bg-green-500/10 text-green-500 border-0 gap-1">
              <CheckCircle className="w-3 h-3" /> OK
            </Badge>
          )}
          {status === 'electing' && (
            <Badge className="bg-yellow-500/10 text-yellow-500 border-0 gap-1">
              <AlertTriangle className="w-3 h-3" /> Electing — no leader
            </Badge>
          )}
          {status === 'fail-slots' && (
            <Badge className="bg-destructive/10 text-destructive border-0 gap-1">
              <XCircle className="w-3 h-3" /> Fail — slots unavailable
            </Badge>
          )}
          {status === 'no-quorum' && (
            <Badge className="bg-destructive/10 text-destructive border-0 gap-1">
              <XCircle className="w-3 h-3" /> Fail (no quorum)
            </Badge>
          )}
          <span className="text-sm text-muted-foreground ml-2">Role:</span>
          <Badge className={`${roleConfig.bg} ${roleConfig.color} border-0`}>{roleConfig.label}</Badge>
        </div>

        {/* Term + log progress */}
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="p-2 bg-muted/30 rounded">
            <p className="text-xs text-muted-foreground">Current term</p>
            <p className="font-mono font-medium">{raft.currentTerm.toLocaleString()}</p>
          </div>
          <div className="p-2 bg-muted/30 rounded">
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <GitCommitHorizontal className="w-3 h-3" /> Commit index
            </p>
            <p className="font-mono font-medium">{raft.commitIndex.toLocaleString()}</p>
          </div>
          <div className="p-2 bg-muted/30 rounded">
            <p className="text-xs text-muted-foreground">Last applied</p>
            <p className="font-mono font-medium">
              {raft.lastApplied.toLocaleString()}
              {applyLag > 0 && (
                <span className="text-yellow-500 text-xs ml-1">(-{applyLag.toLocaleString()})</span>
              )}
            </p>
          </div>
          <div className="p-2 bg-muted/30 rounded">
            <p className="text-xs text-muted-foreground">Log entries</p>
            <p className="font-mono font-medium">{raft.logEntries.toLocaleString()}</p>
          </div>
        </div>

        {/* Leader id */}
        <div className="text-sm">
          <span className="text-muted-foreground">Leader: </span>
          {raft.leaderId ? (
            <span className="font-mono text-xs break-all">{raft.leaderId}</span>
          ) : (
            <span className="text-destructive">none elected</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
