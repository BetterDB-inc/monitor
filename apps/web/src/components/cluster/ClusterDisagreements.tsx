import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { nodeHref } from '@/lib/clusterNodeHref';
import { formatSlotRanges } from '@/types/cluster';
import type {
  AnomalySeverity,
  DisagreementCoverage,
  DisagreementLine,
  DisagreementPosition,
  DisagreementShard,
  DisagreementShardState,
  DivergenceNode,
  TopologyDisagreementSummary,
} from '@/types/anomaly';

const SHORT_ID_LENGTH = 8;
const MAX_LISTED_RANGES = 3;
const EVENTS_PATH = '/anomalies';

const SEVERITY_BADGE: Record<
  AnomalySeverity,
  { label: string; variant: 'destructive' | 'warning' | 'secondary' }
> = {
  critical: { label: 'Critical', variant: 'destructive' },
  warning: { label: 'Warning', variant: 'warning' },
  info: { label: 'Info', variant: 'secondary' },
};

const SHARD_BADGE: Record<
  DisagreementShardState,
  { label: string; variant: 'warning' | 'outline' | 'secondary' }
> = {
  disputed: { label: 'Disputed', variant: 'warning' },
  undisputed: { label: 'No disagreement', variant: 'outline' },
  not_compared: { label: 'Not compared', variant: 'secondary' },
};

const SIDE_LABELS: Record<string, string> = {
  'fail?': 'suspected (fail?)',
  fail: 'failed (fail)',
  known: 'a member',
  handshake: 'in handshake',
  noaddr: 'without an address',
  missing: 'not known',
};

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function nameOf(node: DivergenceNode): string {
  return node.address || node.nodeId.slice(0, SHORT_ID_LENGTH);
}

function sideLabel(line: DisagreementLine, position: DisagreementPosition, index: number): string {
  if (position.value === null) return `Side ${index + 1}`;
  if (line.kind === 'slot_owner') return position.owner ? 'owned by' : position.value;
  if (line.kind === 'config_epoch') return `epoch ${position.value}`;
  return SIDE_LABELS[position.value] ?? position.value;
}

function NodeChip({ node, connectionId }: { node: DivergenceNode; connectionId?: string }) {
  const zone = node.availabilityZone ? ` (${node.availabilityZone})` : '';
  return (
    <Link
      to={nodeHref(node.nodeId, connectionId)}
      title={`${node.nodeId}${zone}`}
      className="rounded border px-1.5 py-0.5 font-mono text-xs hover:bg-muted"
    >
      {nameOf(node)}
    </Link>
  );
}

function NodeChips({
  nodes,
  count,
  connectionId,
}: {
  nodes: DivergenceNode[];
  count: number;
  connectionId?: string;
}) {
  const hidden = count - nodes.length;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {nodes.map((node) => (
        <NodeChip key={node.nodeId} node={node} connectionId={connectionId} />
      ))}
      {hidden > 0 && <span className="text-xs text-muted-foreground">+{hidden} more</span>}
    </span>
  );
}

function coverageText(coverage: DisagreementCoverage): string {
  if (coverage.complete) return `All ${plural(coverage.nodes, 'node')} answered`;
  return `${coverage.asked} of ${plural(coverage.nodes, 'node')} asked, ${coverage.answered} answered`;
}

function DisagreementCard({
  line,
  connectionId,
}: {
  line: DisagreementLine;
  connectionId?: string;
}) {
  const badge = SEVERITY_BADGE[line.severity] ?? SEVERITY_BADGE.info;
  return (
    <article
      id={`disagreement-${line.id}`}
      aria-label={line.text}
      className="space-y-2 rounded-md border p-3"
    >
      <div className="flex flex-wrap items-start gap-2">
        <Badge variant={badge.variant}>{badge.label}</Badge>
        <p className="min-w-0 flex-1 text-sm font-medium">{line.text}</p>
        <span className="text-xs text-muted-foreground">
          since {new Date(line.since).toLocaleTimeString()}
        </span>
        {line.confirmed && line.eventId ? (
          <Link to={EVENTS_PATH} className="text-xs underline">
            Open event
          </Link>
        ) : (
          <span className="text-xs text-muted-foreground">
            Not confirmed yet, seen in {plural(line.rounds, 'round')}
          </span>
        )}
      </div>
      {line.kind !== 'slot_owner' && (
        <div
          role="group"
          aria-label="Nodes this line is about"
          className="flex flex-wrap items-center gap-2 text-sm"
        >
          <span className="text-muted-foreground">About</span>
          <NodeChips nodes={line.subjects} count={line.subjectCount} connectionId={connectionId} />
        </div>
      )}
      <ul className="space-y-1">
        {line.positions.map((position, index) => (
          <li key={index} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="w-20 shrink-0 tabular-nums">{plural(position.count, 'view')}</span>
            <span className="text-muted-foreground">{sideLabel(line, position, index)}</span>
            {position.owner && <NodeChip node={position.owner} connectionId={connectionId} />}
            <span className="text-muted-foreground">from</span>
            <NodeChips
              nodes={position.observers}
              count={position.count}
              connectionId={connectionId}
            />
          </li>
        ))}
      </ul>
      {line.epochs && (
        <Table aria-label="Epochs per node">
          <TableHeader>
            <TableRow>
              <TableHead>Node</TableHead>
              {line.positions.map((_, index) => (
                <TableHead key={index}>Side {index + 1}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {line.epochs.map((entry) => (
              <TableRow key={entry.node.nodeId}>
                <TableCell>
                  <NodeChip node={entry.node} connectionId={connectionId} />
                </TableCell>
                {entry.values.map((value, index) => (
                  <TableCell key={index} className="tabular-nums">
                    {value}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </article>
  );
}

function slotsText(slots: number[][]): string {
  if (slots.length === 0) return '—';
  const listed = formatSlotRanges(slots.slice(0, MAX_LISTED_RANGES));
  const hidden = slots.length - MAX_LISTED_RANGES;
  return hidden > 0 ? `${listed} +${hidden} more` : listed;
}

function viewsText(shard: DisagreementShard): string {
  if (shard.ownViews === 0) return `No view from its ${plural(shard.nodes, 'node')}`;
  return `${shard.ownViews} of ${plural(shard.nodes, 'node')} answered`;
}

function ShardRow({ shard, connectionId }: { shard: DisagreementShard; connectionId?: string }) {
  const badge = SHARD_BADGE[shard.state];
  const [firstId] = shard.disagreementIds;
  return (
    <TableRow>
      <TableCell>
        <Badge variant={badge.variant}>{badge.label}</Badge>
      </TableCell>
      <TableCell className="font-mono text-xs" title={shard.shardId}>
        {shard.shardId.slice(0, SHORT_ID_LENGTH)}
      </TableCell>
      <TableCell>
        {shard.primary ? <NodeChip node={shard.primary} connectionId={connectionId} /> : '—'}
      </TableCell>
      <TableCell className="tabular-nums">{shard.replicas}</TableCell>
      <TableCell>{shard.zones.join(', ') || '—'}</TableCell>
      <TableCell className="font-mono text-xs">{slotsText(shard.slots)}</TableCell>
      <TableCell>
        {firstId ? (
          <a href={`#disagreement-${firstId}`} className="underline">
            {plural(shard.disagreementIds.length, 'disagreement')}
          </a>
        ) : (
          '—'
        )}
      </TableCell>
      <TableCell className="text-muted-foreground">{viewsText(shard)}</TableCell>
    </TableRow>
  );
}

function Shards({ shards, connectionId }: { shards: DisagreementShard[]; connectionId?: string }) {
  const [onlyDisputed, setOnlyDisputed] = useState(false);
  const shown = onlyDisputed ? shards.filter((shard) => shard.state === 'disputed') : shards;
  const title =
    shown.length === shards.length
      ? `Shards (${shards.length})`
      : `Shards (${shown.length} of ${shards.length})`;
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle>{title}</CardTitle>
        <label className="flex items-center gap-2 text-sm">
          <Switch
            aria-label="Only disputed"
            checked={onlyDisputed}
            onCheckedChange={setOnlyDisputed}
          />
          Only disputed
        </label>
      </CardHeader>
      <CardContent>
        <Table aria-label="Shards">
          <TableHeader>
            <TableRow>
              <TableHead>State</TableHead>
              <TableHead>Shard</TableHead>
              <TableHead>Primary</TableHead>
              <TableHead>Replicas</TableHead>
              <TableHead>Zones</TableHead>
              <TableHead>Slots</TableHead>
              <TableHead>Disagreements</TableHead>
              <TableHead>Own views</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((shard) => (
              <ShardRow key={shard.shardId} shard={shard} connectionId={connectionId} />
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function ClusterDisagreementsLocked() {
  return (
    <Card>
      <CardContent className="space-y-1 pt-6">
        <p className="font-medium">Cluster view disagreements are available in Pro</p>
        <p className="text-sm text-muted-foreground">
          Upgrade to see where the nodes of this cluster disagree about slot owners, failures and
          membership.
        </p>
      </CardContent>
    </Card>
  );
}

export function ClusterDisagreements({
  summary,
  error,
  connectionId,
}: {
  summary: TopologyDisagreementSummary | undefined;
  error?: Error | null;
  connectionId?: string;
}) {
  if (!summary) {
    if (error) {
      return (
        <p role="alert" className="text-sm text-destructive">
          The disagreements could not be loaded. This does not mean the views agree.
        </p>
      );
    }
    return (
      <div role="status" aria-label="Loading disagreements" className="space-y-2">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (summary.status === 'not_sampled') {
    return (
      <EmptyState
        title="Not sampled yet"
        description="The views of the nodes are compared in rounds, and this cluster has had none yet. A cluster that is not a gossip cluster, or one with the topology divergence check switched off, is never sampled."
      />
    );
  }

  const { coverage, disagreements, shards } = summary;
  const compared = summary.status === 'ok';

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Disagreements ({disagreements.length})</CardTitle>
          <p className="text-sm text-muted-foreground">
            <span>{coverageText(coverage)}</span>
            {summary.sampledAt !== null && (
              <span> · last round {new Date(summary.sampledAt).toLocaleTimeString()}</span>
            )}
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {error && (
            <p role="alert" className="text-sm text-destructive">
              The disagreements could not be refreshed. This is the last answer.
            </p>
          )}
          {!compared && (
            <p role="alert" className="text-sm text-destructive">
              Fewer than two nodes answered, so nothing could be compared.
            </p>
          )}
          {compared && !coverage.complete && (
            <p className="text-sm text-muted-foreground">
              Counts are over the views that answered. Nodes that were not asked may disagree too.
            </p>
          )}
          {coverage.unansweredCount > 0 && (
            <div
              role="group"
              aria-label="Nodes that did not answer"
              className="flex flex-wrap items-center gap-2 text-sm"
            >
              <span>
                {coverage.unansweredCount === 1
                  ? '1 node did not answer:'
                  : `${coverage.unansweredCount} nodes did not answer:`}
              </span>
              <NodeChips
                nodes={coverage.unanswered}
                count={coverage.unansweredCount}
                connectionId={connectionId}
              />
            </div>
          )}
          {compared && disagreements.length === 0 && (
            <p className="text-sm">
              No disagreements among the {plural(coverage.answered, 'view')} compared.
            </p>
          )}
          {disagreements.map((line) => (
            <DisagreementCard key={line.id} line={line} connectionId={connectionId} />
          ))}
        </CardContent>
      </Card>
      {shards.length > 0 && <Shards shards={shards} connectionId={connectionId} />}
    </div>
  );
}
