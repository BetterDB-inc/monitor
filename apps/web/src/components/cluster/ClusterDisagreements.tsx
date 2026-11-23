import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { INCIDENT_LOOKBACK_MS, incidentEventPath } from '@betterdb/shared';
import { ApiError } from '@/api/client';
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
import { useCanMutate } from '@/hooks/useCanMutate';
import { useNow } from '@/hooks/useNow';
import { nodeHref } from '@/lib/clusterNodeHref';
import { CONNECTION_PARAM } from '@/lib/connectionParam';
import { formatSlotRanges } from '@/types/cluster';
import type {
  AnomalySeverity,
  DisagreementCoverage,
  DisagreementLine,
  DisagreementPosition,
  DisagreementShard,
  DisagreementShardState,
  DivergenceNode,
  FullCheckFailure,
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
const TOO_MANY_REQUESTS = 429;

type ResultShown = 'sampled' | 'full';

interface AwaitedCheck {
  after: number | null;
  failedAt: number | null;
  error: Error | null;
}

interface ClusterDisagreementsProps {
  summary: TopologyDisagreementReport | undefined;
  receivedAt?: number | null;
  error?: Error | null;
  connectionId?: string;
  onAskEveryNode?: () => void;
  asking?: boolean;
  askError?: Error | null;
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

function eventsHref(connectionId?: string): string {
  if (!connectionId) return EVENTS_PATH;
  return `${EVENTS_PATH}?${new URLSearchParams({ [CONNECTION_PARAM]: connectionId }).toString()}`;
}

function eventHref(line: DisagreementLine, asOf: number | null, connectionId?: string): string {
  const holder = line.eventConnectionId ?? connectionId;
  if (line.eventId === null || line.eventAt === null) return eventsHref(holder);
  if ((asOf ?? line.lastSeenAt) - line.eventAt > INCIDENT_LOOKBACK_MS) return eventsHref(holder);
  return incidentEventPath(line.eventId, line.eventAt, holder);
}

function coverageText(coverage: DisagreementCoverage): string {
  if (coverage.complete) return `All ${plural(coverage.nodes, 'node')} answered`;
  return `${coverage.asked} of ${plural(coverage.nodes, 'node')} asked, ${coverage.answered} answered`;
}

function LineStanding({
  line,
  asOf,
  connectionId,
}: {
  line: DisagreementLine;
  asOf: number | null;
  connectionId?: string;
}) {
  if (line.confirmed && line.eventId) {
    return (
      <Link to={eventHref(line, asOf, connectionId)} className="text-xs underline">
        Open event
      </Link>
    );
  }
  if (line.resolvedByHand) {
    return (
      <span className="text-xs text-muted-foreground">
        {line.stale
          ? 'Event resolved by hand; the disagreement itself was not checked again'
          : 'Event resolved by hand, the disagreement is still seen'}
      </span>
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
  asOf,
  connectionId,
}: {
  line: DisagreementLine;
  asOf: number | null;
  connectionId?: string;
}) {
  const badge = SEVERITY_BADGE[line.severity] ?? SEVERITY_BADGE.info;
  const hiddenEpochs = line.subjectCount - (line.epochs?.length ?? 0);
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
            Last seen {new Date(line.lastSeenAt).toLocaleTimeString()}, not checked again this round
          </span>
        ) : (
          line.since !== undefined && (
            <span className="text-xs text-muted-foreground">
              since {new Date(line.since).toLocaleTimeString()}
            </span>
          )
        )}
        <LineStanding line={line} asOf={asOf} connectionId={connectionId} />
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
            {hiddenEpochs > 0 && (
              <TableRow>
                <TableCell
                  colSpan={line.positions.length + 1}
                  className="text-xs text-muted-foreground"
                >
                  +{hiddenEpochs} more
                </TableCell>
              </TableRow>
            )}
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

function TakenLine({ takenAt, clockAhead }: { takenAt: number; clockAhead: number }) {
  const now = useNow(true, CLOCK_TICK_MS);
  return <p className="text-sm text-muted-foreground">{takenText(takenAt, now - clockAhead)}</p>;
}

function failureText(check: TopologyFullCheck, failure: FullCheckFailure): string {
  const failed = `The last full check failed at ${new Date(failure.at).toLocaleTimeString()}: ${failure.reason}.`;
  if (check.state !== 'done' || check.finishedAt === null) return failed;
  const earlier = new Date(check.finishedAt).toLocaleTimeString();
  return `${failed} The full check on offer is the one before it, taken ${earlier}.`;
}

function isTooSoon(error: Error | null | undefined): error is ApiError {
  return error instanceof ApiError && error.status === TOO_MANY_REQUESTS;
}

function retryAtOf(error: ApiError): number {
  const retryAt = (error.payload as { retryAt?: unknown } | null)?.retryAt;
  return typeof retryAt === 'number' ? retryAt : 0;
}

function useWaitingUntil(until: number): boolean {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (now >= until) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, until - Date.now()));
    return () => clearTimeout(timer);
  }, [until, now]);
  return now < until;
}

function AskEveryNode({
  check,
  canAsk,
  asking,
  waiting,
  onAsk,
}: {
  check: TopologyFullCheck;
  canAsk: boolean;
  asking: boolean;
  waiting: boolean;
  onAsk: () => void;
}) {
  if (check.unavailable) {
    return <p className="text-sm text-muted-foreground">{check.unavailable.text}</p>;
  }
  if (!canAsk) {
    return (
      <p className="text-sm text-muted-foreground">Only a workspace admin can ask every node.</p>
    );
  }
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={asking || waiting || check.state === 'running'}
      onClick={onAsk}
    >
      Ask every node
    </Button>
  );
}

function FullCheckBar({
  check,
  shown,
  onShow,
  onAsk,
  canAsk,
  asking,
  waiting,
  askError,
}: {
  check: TopologyFullCheck;
  shown: ResultShown;
  onShow: (shown: ResultShown) => void;
  onAsk: () => void;
  canAsk: boolean;
  asking: boolean;
  waiting: boolean;
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
        <AskEveryNode
          check={check}
          canAsk={canAsk}
          asking={asking}
          waiting={waiting}
          onAsk={onAsk}
        />
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
      {check.lastFailure && (
        <p role="alert" className="text-sm text-destructive">
          {failureText(check, check.lastFailure)}
        </p>
      )}
    </div>
  );
}

function RefreshError() {
  return (
    <p role="alert" className="text-sm text-destructive">
      The disagreements could not be refreshed. This is the last answer.
    </p>
  );
}

function Result({
  summary,
  takenAt,
  clockAhead = 0,
  error,
  connectionId,
}: {
  summary: TopologyDisagreementSummary;
  takenAt: number | null;
  clockAhead?: number;
  error?: Error | null;
  connectionId?: string;
}) {
  if (summary.status === 'not_sampled') {
    return (
      <div className="space-y-3">
        {error && <RefreshError />}
        <EmptyState
          title="Not sampled yet"
          description="The views of the nodes are compared in rounds, and this cluster has had none yet. A cluster that is not a gossip cluster, or one with the topology divergence check switched off, is never sampled."
        />
      </div>
    );
  }

  const { coverage, shards } = summary;
  const compared = summary.status === 'ok';
  const disagreements = summary.disagreements.filter((line) => line.open);
  const unconfirmed = summary.disagreements.filter((line) => !line.open);
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
          {oneOff && <TakenLine takenAt={takenAt} clockAhead={clockAhead} />}
        </CardHeader>
        <CardContent className="space-y-3">
          {error && <RefreshError />}
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
              {unconfirmed.length > 0
                ? 'No disagreements confirmed this round.'
                : `No disagreements among the ${plural(coverage.answered, 'view')} compared.`}
            </p>
          )}
          {disagreements.map((line) => (
            <DisagreementCard
              key={line.id}
              line={line}
              asOf={summary.sampledAt}
              connectionId={connectionId}
            />
          ))}
          {unconfirmed.length > 0 && (
            <section aria-label="Not confirmed this round" className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {unconfirmed.length === 1
                  ? '1 disagreement from an earlier round could not be checked again in the last round. It is neither confirmed nor cleared.'
                  : `${unconfirmed.length} disagreements from an earlier round could not be checked again in the last round. They are neither confirmed nor cleared.`}
              </p>
              {unconfirmed.map((line) => (
                <DisagreementCard
                  key={line.id}
                  line={line}
                  asOf={summary.sampledAt}
                  connectionId={connectionId}
                />
              ))}
            </section>
          )}
        </CardContent>
      </Card>
      {shards.length > 0 && <Shards shards={shards} connectionId={connectionId} />}
    </div>
  );
}

export function ClusterDisagreements(props: ClusterDisagreementsProps) {
  return <ConnectionDisagreements key={props.connectionId ?? ''} {...props} />;
}

function ConnectionDisagreements({
  summary,
  receivedAt,
  error,
  connectionId,
  onAskEveryNode,
  asking = false,
  askError,
}: ClusterDisagreementsProps) {
  const canAsk = useCanMutate();
  const [pickedCheck, setPickedCheck] = useState<number | null>(null);
  const [awaited, setAwaited] = useState<AwaitedCheck | null>(null);
  const check = summary?.fullCheck;
  const finishedAt = check?.state === 'done' ? check.finishedAt : null;
  const failedAt = check?.lastFailure?.at ?? null;
  const full = check?.state === 'done' ? check.summary : undefined;
  const tooSoon = isTooSoon(askError);
  const clockAhead = check && receivedAt != null ? receivedAt - check.now : 0;
  const retryAt = Math.max(check?.retryAt ?? 0, tooSoon ? retryAtOf(askError) : 0);
  const waiting = useWaitingUntil(retryAt > 0 ? retryAt + clockAhead : 0);
  const waitIsOver = retryAt > 0 && !waiting;

  if (awaited && askError && askError !== awaited.error) {
    setAwaited(null);
  } else if (awaited && failedAt !== null && failedAt !== awaited.failedAt) {
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
    setAwaited({ after: finishedAt, failedAt, error: askError ?? null });
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
          canAsk={canAsk}
          asking={asking}
          waiting={waiting}
          askError={tooSoon && waitIsOver ? null : askError}
        />
      )}
      {shown === 'full' && full ? (
        <Result
          summary={full}
          takenAt={finishedAt}
          clockAhead={clockAhead}
          connectionId={connectionId}
        />
      ) : (
        <Result summary={summary} takenAt={null} error={error} connectionId={connectionId} />
      )}
    </div>
  );
}
