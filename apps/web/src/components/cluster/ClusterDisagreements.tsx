import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import { useNow } from '@/hooks/useNow';
import { isOpenDisagreement } from '@/lib/clusterDisagreements';
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
  TopologyDisagreementReport,
  TopologyDisagreementSummary,
  TopologyFullCheck,
} from '@/types/anomaly';

const SHORT_ID_LENGTH = 8;
const MAX_LISTED_RANGES = 3;
const EVENTS_PATH = '/anomalies';
const FULL_CHECK_FRESH_MS = 60_000;
const MINUTE_MS = 60_000;
const CLOCK_TICK_MS = 10_000;

type ResultShown = 'sampled' | 'full';

interface AwaitedCheck {
  after: number | null;
  error: Error | null;
}

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

function LineStanding({ line }: { line: DisagreementLine }) {
  if (line.confirmed && line.eventId) {
    return (
      <Link to={EVENTS_PATH} className="text-xs underline">
        Open event
      </Link>
    );
  }
  if (line.tracked === false || line.rounds === undefined) {
    return <span className="text-xs text-muted-foreground">One-off check, not tracked</span>;
  }
  return (
    <span className="text-xs text-muted-foreground">
      Not confirmed yet, seen in {plural(line.rounds, 'round')}
    </span>
  );
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
      className={`space-y-2 rounded-md border p-3 ${line.stale ? 'border-dashed' : ''}`}
    >
      <div className="flex flex-wrap items-start gap-2">
        <Badge variant={badge.variant}>{badge.label}</Badge>
        <p className="min-w-0 flex-1 text-sm font-medium">{line.text}</p>
        {line.stale ? (
          <span className="text-xs text-muted-foreground">
            Last seen {new Date(line.lastSeenAt).toLocaleTimeString()}, not confirmed this round
          </span>
        ) : (
          line.since !== undefined && (
            <span className="text-xs text-muted-foreground">
              since {new Date(line.since).toLocaleTimeString()}
            </span>
          )
        )}
        <LineStanding line={line} />
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
              count={position.observerCount}
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
  const [firstStaleId] = shard.staleDisagreementIds;
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
        {firstId && (
          <a href={`#disagreement-${firstId}`} className="underline">
            {plural(shard.disagreementIds.length, 'disagreement')}
          </a>
        )}
        {firstId && firstStaleId && ', '}
        {firstStaleId && (
          <a href={`#disagreement-${firstStaleId}`} className="underline">
            {shard.staleDisagreementIds.length} unconfirmed
          </a>
        )}
        {!firstId && !firstStaleId && '—'}
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

export function ClusterDisagreementsLoading() {
  return (
    <div role="status" aria-label="Loading disagreements" className="space-y-2">
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
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

function takenText(finishedAt: number, now: number): string {
  const age = now - finishedAt;
  if (age <= FULL_CHECK_FRESH_MS) {
    return `One-off check taken ${new Date(finishedAt).toLocaleTimeString()}. It does not update.`;
  }
  return `Taken ${plural(Math.floor(age / MINUTE_MS), 'minute')} ago. The cluster may have changed since.`;
}

function TakenLine({ takenAt }: { takenAt: number }) {
  const now = useNow(true, CLOCK_TICK_MS);
  return <p className="text-sm text-muted-foreground">{takenText(takenAt, now)}</p>;
}

function FullCheckBar({
  check,
  shown,
  onShow,
  onAsk,
  asking,
  askError,
}: {
  check: TopologyFullCheck;
  shown: ResultShown;
  onShow: (shown: ResultShown) => void;
  onAsk: () => void;
  asking: boolean;
  askError?: Error | null;
}) {
  const result = check.state === 'done' ? check.summary : undefined;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {result && check.finishedAt !== null ? (
          <div role="group" aria-label="Result shown" className="flex flex-wrap gap-1">
            <Button
              size="sm"
              variant={shown === 'sampled' ? 'secondary' : 'ghost'}
              aria-pressed={shown === 'sampled'}
              onClick={() => onShow('sampled')}
            >
              Sampled (live)
            </Button>
            <Button
              size="sm"
              variant={shown === 'full' ? 'secondary' : 'ghost'}
              aria-pressed={shown === 'full'}
              onClick={() => onShow('full')}
            >
              Full check {new Date(check.finishedAt).toLocaleTimeString()} ·{' '}
              {result.coverage.answered} of {result.coverage.nodes} answered
            </Button>
          </div>
        ) : (
          <span />
        )}
        {check.unavailable ? (
          <p className="text-sm text-muted-foreground">{check.unavailable.text}</p>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={asking || check.state === 'running'}
            onClick={onAsk}
          >
            Ask every node
          </Button>
        )}
      </div>
      {check.state === 'running' && (
        <p role="status" aria-label="Full check progress" className="text-sm text-muted-foreground">
          Asking every node: {check.asked} of {check.total} asked
        </p>
      )}
      {askError && (
        <p role="alert" className="text-sm text-destructive">
          {askError.message}
        </p>
      )}
    </div>
  );
}

function Result({
  summary,
  takenAt,
  error,
  connectionId,
}: {
  summary: TopologyDisagreementSummary;
  takenAt: number | null;
  error?: Error | null;
  connectionId?: string;
}) {
  if (summary.status === 'not_sampled') {
    return (
      <EmptyState
        title="Not sampled yet"
        description="The views of the nodes are compared in rounds, and this cluster has had none yet. A cluster that is not a gossip cluster, or one with the topology divergence check switched off, is never sampled."
      />
    );
  }

  const { coverage, shards } = summary;
  const compared = summary.status === 'ok';
  const disagreements = summary.disagreements.filter(isOpenDisagreement);
  const unconfirmed = summary.disagreements.filter((line) => !isOpenDisagreement(line));
  const oneOff = takenAt !== null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Disagreements ({disagreements.length})</CardTitle>
          <p className="text-sm text-muted-foreground">
            <span>{coverageText(coverage)}</span>
            {!oneOff && summary.sampledAt !== null && (
              <span> · last round {new Date(summary.sampledAt).toLocaleTimeString()}</span>
            )}
          </p>
          {oneOff && <TakenLine takenAt={takenAt} />}
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
              {oneOff
                ? 'Counts are over the nodes that answered. A node that gave no answer is not counted as agreeing.'
                : 'Counts are over the views that answered. Nodes that were not asked may disagree too.'}
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
          {unconfirmed.length > 0 && (
            <section aria-label="Not confirmed this round" className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {unconfirmed.length === 1
                  ? '1 disagreement from an earlier round could not be checked again in the last round. It is neither confirmed nor cleared.'
                  : `${unconfirmed.length} disagreements from an earlier round could not be checked again in the last round. They are neither confirmed nor cleared.`}
              </p>
              {unconfirmed.map((line) => (
                <DisagreementCard key={line.id} line={line} connectionId={connectionId} />
              ))}
            </section>
          )}
        </CardContent>
      </Card>
      {shards.length > 0 && <Shards shards={shards} connectionId={connectionId} />}
    </div>
  );
}

export function ClusterDisagreements({
  summary,
  error,
  connectionId,
  onAskEveryNode,
  asking = false,
  askError,
}: {
  summary: TopologyDisagreementReport | undefined;
  error?: Error | null;
  connectionId?: string;
  onAskEveryNode?: () => void;
  asking?: boolean;
  askError?: Error | null;
}) {
  const [pickedCheck, setPickedCheck] = useState<number | null>(null);
  const [awaited, setAwaited] = useState<AwaitedCheck | null>(null);
  const check = summary?.fullCheck;
  const finishedAt = check?.state === 'done' ? check.finishedAt : null;
  const full = check?.state === 'done' ? check.summary : undefined;

  if (awaited && askError && askError !== awaited.error) {
    setAwaited(null);
  } else if (awaited && finishedAt !== null && finishedAt !== awaited.after) {
    setPickedCheck(finishedAt);
    setAwaited(null);
  }

  if (!summary) {
    if (error) {
      return (
        <p role="alert" className="text-sm text-destructive">
          The disagreements could not be loaded. This does not mean the views agree.
        </p>
      );
    }
    return <ClusterDisagreementsLoading />;
  }

  const shown: ResultShown =
    full && finishedAt !== null && pickedCheck === finishedAt ? 'full' : 'sampled';
  const show = (result: ResultShown) => {
    setAwaited(null);
    setPickedCheck(result === 'full' ? finishedAt : null);
  };
  const ask = () => {
    setAwaited({ after: finishedAt, error: askError ?? null });
    onAskEveryNode?.();
  };

  return (
    <div className="space-y-4">
      {check && (
        <FullCheckBar
          check={check}
          shown={shown}
          onShow={show}
          onAsk={ask}
          asking={asking}
          askError={askError}
        />
      )}
      {shown === 'full' && full ? (
        <Result summary={full} takenAt={finishedAt} connectionId={connectionId} />
      ) : (
        <Result summary={summary} takenAt={null} error={error} connectionId={connectionId} />
      )}
    </div>
  );
}
