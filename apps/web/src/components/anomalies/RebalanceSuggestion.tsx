import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { displayKeyName, type PlacementMode } from '@betterdb/shared';
import { ApiError } from '../../api/client';
import { metricsApi } from '../../api/metrics';
import { useCanMutate } from '../../hooks/useCanMutate';
import { useOpenHotShards } from '../../hooks/useOpenHotShards';
import { copyToClipboard } from '../../lib/clipboard';
import { REBALANCE_BLOCKED, formatRatio, slotRangeLabels, shortShardId } from './anomaly-display';
import type {
  HotShardDetail,
  RebalanceCommand,
  RebalanceExecutionBlocker,
  RebalanceMove,
  RebalanceNoPlan,
  RebalanceNoPlanReason,
  RebalancePinnedSlot,
  RebalancePlan,
  RebalanceRecheckFailure,
  RebalanceSupport,
  RebalanceWarning,
} from '../../types/anomaly';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';

const COPIED_FOR_MS = 2000;

interface Props {
  connectionId: string | undefined;
  mode?: PlacementMode;
  runnable?: boolean;
}

const percent = (share: number) => `${Math.round(share * 100)}%`;
const ofCore = (cpuUsecPerSecond: number) => percent(cpuUsecPerSecond / 1_000_000);
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumSignificantDigits: 2 });
const keys = (count: number) => compact.format(count).toLowerCase();

function listed(parts: string[]): string {
  if (parts.length < 2) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function describeMove(move: RebalanceMove): string {
  const ranges = slotRangeLabels(move.ranges);
  const single = move.slotCount === 1;
  return (
    `Move slot${single ? '' : 's'} ${listed(ranges)} ` +
    `(${move.slotCount} slot${single ? '' : 's'}, ${percent(move.shareOfShard)} of this shard's CPU, ` +
    `about ${keys(move.keyCount)} keys) to shard ${shortShardId(move.targetShardId)} at ${move.targetAddr}.`
  );
}

function describePinned(pinned: RebalancePinnedSlot[]): string {
  const parts = pinned.map(
    (slot, index) =>
      `slot ${slot.slot} (${percent(slot.shareOfShard)}${index === 0 ? " of this shard's CPU" : ''})`,
  );
  return `Not moved: ${listed(parts)}.`;
}

function describeWarning(warning: RebalanceWarning): string {
  const shard = `shard ${shortShardId(warning.shardId)}`;
  switch (warning.code) {
    case 'source_fork':
      return 'The hot shard forks to send the slots, while it is the busiest node.';
    case 'fewer_replicas':
      return `Shard ${shortShardId(warning.shardId)} has fewer replicas than the hot shard.`;
    case 'target_memory':
      return `Shard ${shortShardId(warning.shardId)} would be at about ${percent(warning.memoryShare ?? 0)} of its memory limit after the move.`;
    case 'memory_unknown':
      return `The memory room of ${shard} is not known.`;
    case 'memory_unlimited':
      return `Shard ${shortShardId(warning.shardId)} has no maxmemory limit, so BetterDB cannot check that the moved keys fit.`;
  }
}

const NO_COMMAND: Record<Exclude<RebalanceSupport, 'valkey_atomic' | 'redis_atomic'>, string> = {
  none: 'This server version has no single command that moves slots: that needs Valkey 9.0 or Redis 8.4 on every shard of the plan. BetterDB does not script the manual SETSLOT and MIGRATE steps; the slots above are for resharding by hand.',
  provider_managed:
    "Slot commands are not supported on this managed service. Use your provider's resharding with the slots above.",
  unknown: 'The server version could not be read, so no command is shown.',
};

const NO_PLAN_REASONS: Record<
  Exclude<
    RebalanceNoPlanReason,
    'key_level' | 'covered_by_other_plan' | 'conflicts_with_other_plan'
  >,
  string
> = {
  cluster_hot: 'No other shard has room for this load. Consider adding a shard.',
  too_many_targets: 'This load would have to be spread over too many shards for one suggestion.',
  no_target: 'No other primary can take slots.',
  unhealthy_node:
    'A primary that owns slots is failed or suspect. A suggestion comes back when it is healthy again.',
  migration_running:
    'A slot migration is running, or the monitor could not ask every primary whether one is. A suggestion comes back when no migration is running and every primary answers.',
  settling: 'Slots changed owner and the load is still being measured.',
  slots_scattered: "This shard's slots are too scattered to move enough load in a few ranges.",
};

function describeCovered(verdict: RebalanceNoPlan): string {
  const covering = (verdict.coveredBy ?? []).map((shard) => shard.nodeAddr);
  const several = covering.length > 1;
  return (
    `The suggestion${several ? 's' : ''} for ${covering.length > 0 ? listed(covering) : 'another hot shard'} ` +
    `already bring${several ? '' : 's'} this shard's load near the median. ` +
    `Apply ${several ? 'those' : 'that one'} first.`
  );
}

function describeConflict(verdict: RebalanceNoPlan): string {
  const earlier = (verdict.conflictsWith ?? []).map((shard) => shard.nodeAddr);
  const several = earlier.length > 1;
  return (
    `No move from this shard fits next to the suggestion${several ? 's' : ''} for ` +
    `${earlier.length > 0 ? listed(earlier) : 'another hot shard'}. ` +
    `Apply ${several ? 'those' : 'that one'} first.`
  );
}

function describeKeyLevel(verdict: RebalanceNoPlan, shard: HotShardDetail): string {
  const slots = verdict.pinnedSlots;
  const share = percent(slots.reduce((total, slot) => total + slot.shareOfShard, 0));
  if (slots.length === 0) {
    return "Rebalancing will not help: the slots that can move carry too little of this shard's CPU.";
  }
  if (slots.length > 1) {
    const numbers = listed(slots.map((slot) => `${slot.slot}`));
    return `Rebalancing will not help: slots ${numbers} are ${share} of this shard's CPU.`;
  }
  const key = shard.topKeys.find((top) => top.slot === slots[0].slot);
  return (
    `Rebalancing will not help: slot ${slots[0].slot} alone is ${share} of this shard's CPU.` +
    (key ? ` Its hottest key is "${displayKeyName(key.key)}".` : '')
  );
}

function describeIsolate(slots: RebalancePinnedSlot[]): string {
  const advice = 'This is advice: BetterDB does not run it.';
  if (slots.length === 1) return `Moving slot ${slots[0].slot} to a shard of its own (Isolate). ${advice}`;
  const numbers = listed(slots.map((slot) => `${slot.slot}`));
  return `Moving slots ${numbers} each to a shard of its own (Isolate). ${advice}`;
}

function CommandLine({ command, label }: { command: RebalanceCommand; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!(await copyToClipboard(command.text))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), COPIED_FOR_MS);
  };
  return (
    <div className="space-y-1">
      {label && <p className="text-muted-foreground">{label}</p>}
      <div className="flex items-start gap-2">
        <code className="min-w-0 flex-1 rounded bg-muted px-2 py-1 font-mono text-xs break-words">
          {command.text}
        </code>
        <Button
          size="sm"
          variant="outline"
          onClick={copy}
          aria-label={copied ? 'Copied' : 'Copy command'}
        >
          {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
        </Button>
      </div>
    </div>
  );
}

function Commands({ plan, runnable }: { plan: RebalancePlan; runnable: boolean }) {
  const support = plan.support ?? 'unknown';
  const commands = plan.commands ?? [];
  if ((support !== 'valkey_atomic' && support !== 'redis_atomic') || commands.length === 0) {
    return (
      <p className="text-muted-foreground">
        {
          NO_COMMAND[
            support === 'valkey_atomic' || support === 'redis_atomic' ? 'unknown' : support
          ]
        }
      </p>
    );
  }
  const valkey = support === 'valkey_atomic';
  return (
    <div className="space-y-2">
      <p>
        {valkey
          ? `Run this on the hot shard (${commands[0].nodeAddr}). The server starts all of the moves or none.`
          : 'Run each command on its target shard.'}{' '}
        {runnable ? 'Or start it from BetterDB below.' : 'BetterDB does not run it.'}
      </p>
      {commands.map((command) => (
        <CommandLine
          key={`${command.nodeAddr} ${command.text}`}
          command={command}
          label={valkey ? undefined : `On ${command.nodeAddr}`}
        />
      ))}
    </div>
  );
}


const REFUSED: Record<RebalanceRecheckFailure | 'plan_changed' | 'no_plan', string> = {
  plan_changed: 'The suggestion changed since you opened it. Review the new one.',
  no_plan: 'There is no suggestion to run any more.',
  slots_moved: 'The hot shard no longer owns these slots. A new suggestion follows.',
  source_unhealthy: 'The hot shard is not a healthy primary now.',
  target_unhealthy: 'A target shard is not a healthy primary now.',
};

function refusal(err: unknown): string {
  if (!(err instanceof ApiError)) return err instanceof Error ? err.message : String(err);
  const payload = (err.payload ?? {}) as { reason?: string; blockedBy?: string; message?: string };
  const reason = payload.reason as keyof typeof REFUSED | undefined;
  const blockedBy = payload.blockedBy as RebalanceExecutionBlocker | undefined;
  return (
    (reason && REFUSED[reason]) ||
    (blockedBy && REBALANCE_BLOCKED[blockedBy]) ||
    payload.message ||
    err.message
  );
}

function RunPlan({ plan, onRun }: { plan: RebalancePlan; onRun: (plan: RebalancePlan) => void }) {
  const canMutate = useCanMutate();
  const execution = plan.execution;
  if (!execution || !canMutate) return null;
  if (!execution.available) {
    if (!execution.blockedBy || plan.support !== 'valkey_atomic') return null;
    return <p className="text-muted-foreground">{REBALANCE_BLOCKED[execution.blockedBy]}</p>;
  }
  return (
    <Button size="sm" onClick={() => onRun(plan)}>
      Run this plan
    </Button>
  );
}

const movesKey = (plan: RebalancePlan) =>
  plan.moves
    .map((move) => `${move.targetShardId}:${slotRangeLabels(move.ranges).join(',')}`)
    .join(' ');

function RunDialog({
  shown,
  current,
  connectionId,
  onReview,
  onClose,
}: {
  shown: RebalancePlan;
  current: RebalancePlan | undefined;
  connectionId: string | undefined;
  onReview: (plan: RebalancePlan) => void;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const source = shown.projection.find((row) => row.role === 'source');
  const changed = current !== undefined && movesKey(current) !== movesKey(shown);
  const blockedBy = current?.execution?.available === false ? current.execution.blockedBy : undefined;
  const notice = !current
    ? REFUSED.no_plan
    : changed
      ? REFUSED.plan_changed
      : blockedBy && REBALANCE_BLOCKED[blockedBy];
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['open-hot-shards', connectionId] }),
      queryClient.invalidateQueries({ queryKey: ['slot-rebalance-runs', connectionId] }),
    ]);
  const run = async () => {
    setSending(true);
    setError(null);
    let started = false;
    try {
      await metricsApi.runRebalance(
        shown.sourceShardId,
        shown.moves.map(({ targetShardId, ranges }) => ({ targetShardId, ranges })),
      );
      started = true;
    } catch (err) {
      setError(refusal(err));
    } finally {
      setSending(false);
      await refresh();
    }
    if (started) onClose();
  };
  return (
    <Dialog open onOpenChange={(next) => !sending && !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Run this rebalance?</DialogTitle>
          <DialogDescription>
            BetterDB sends one CLUSTER MIGRATESLOTS to the hot shard
            {source ? ` at ${source.nodeAddr}` : ''}. The server starts all of these moves or none.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <ul className="list-disc pl-5">
            {shown.moves.map((move) => (
              <li key={move.targetShardId}>{describeMove(move)}</li>
            ))}
          </ul>
          {shown.warnings.length > 0 && (
            <ul className="list-disc pl-5 text-yellow-600 dark:text-yellow-500">
              {shown.warnings.map((warning) => (
                <li key={`${warning.code} ${warning.shardId}`}>{describeWarning(warning)}</li>
              ))}
            </ul>
          )}
          <p className="text-muted-foreground">
            Cancel stops every slot migration on the hot shard, not only these. Slots already moved
            stay on their target.
          </p>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          {notice && notice !== error && <p className="text-muted-foreground">{notice}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={sending} onClick={onClose}>
            Keep the plan
          </Button>
          {changed && (
            <Button variant="outline" disabled={sending} onClick={() => onReview(current)}>
              Review the new plan
            </Button>
          )}
          <Button
            disabled={sending || changed || current?.execution?.available !== true}
            onClick={run}
          >
            {sending ? 'Starting…' : 'Start the migration'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function describePlannedAfter(plan: RebalancePlan): string {
  const earlier = plan.plannedAfter.map(
    (shardId) => plan.projection.find((row) => row.shardId === shardId)?.nodeAddr ?? shortShardId(shardId),
  );
  return `These numbers count the suggestion${earlier.length === 1 ? '' : 's'} for ${listed(earlier)} as applied.`;
}

function Plan({ plan, onRun }: { plan: RebalancePlan; onRun: (plan: RebalancePlan) => void }) {
  const canMutate = useCanMutate();
  const source = plan.projection.find((row) => row.role === 'source');
  const moved = plan.moves.reduce((total, move) => total + move.shareOfShard, 0);
  const rows = plan.projection.filter((row) => row.role !== 'other');
  const others = plan.projection.length - rows.length;
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        {source && (
          <p>
            {plan.effect === 'resolves'
              ? `This brings the shard from ${formatRatio(source.before.ratio)} to ${formatRatio(source.after.ratio)} the median.`
              : `This frees ${percent(moved)} of the shard's CPU. The shard stays at ${formatRatio(source.after.ratio)} the median, but the load that stays has more of the node to itself.`}
          </p>
        )}
        <ul className="list-disc pl-5">
          {plan.moves.map((move) => (
            <li key={move.targetShardId}>{describeMove(move)}</li>
          ))}
        </ul>
        {plan.pinnedSlots.length > 0 && (
          <p className="text-muted-foreground">{describePinned(plan.pinnedSlots)}</p>
        )}
      </div>
      <div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Shard</TableHead>
              <TableHead>CPU, of one core</TableHead>
              <TableHead>Share of the cluster</TableHead>
              <TableHead>Ratio to the median</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.shardId}>
                <TableCell>
                  <span className="font-mono">{shortShardId(row.shardId)}</span>{' '}
                  <span className="text-muted-foreground">
                    {row.nodeAddr} · {row.role === 'source' ? 'Hot shard' : 'Target'}
                  </span>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {ofCore(row.before.cpuUsecPerSecond)} → {ofCore(row.after.cpuUsecPerSecond)}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {percent(row.before.share)} → {percent(row.after.share)}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatRatio(row.before.ratio)} → {formatRatio(row.after.ratio)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="text-muted-foreground">
          {others > 0 &&
            `The ${others} other shard${others === 1 ? ' keeps its' : 's keep their'} load. `}
          The median goes from {ofCore(plan.medianBefore)} to {ofCore(plan.medianAfter)} of a core.
        </p>
        {plan.plannedAfter.length > 0 && (
          <p className="text-muted-foreground">{describePlannedAfter(plan)}</p>
        )}
      </div>
      {plan.warnings.length > 0 && (
        <ul aria-label="Warnings" className="list-disc pl-5 text-yellow-600 dark:text-yellow-500">
          {plan.warnings.map((warning) => (
            <li key={`${warning.code} ${warning.shardId}`}>{describeWarning(warning)}</li>
          ))}
        </ul>
      )}
      <Commands plan={plan} runnable={canMutate && plan.execution?.available === true} />
      <RunPlan plan={plan} onRun={onRun} />
    </div>
  );
}

function NoPlan({ verdict, shard }: { verdict: RebalanceNoPlan; shard: HotShardDetail }) {
  if (verdict.reason === 'covered_by_other_plan') return <p>{describeCovered(verdict)}</p>;
  if (verdict.reason === 'conflicts_with_other_plan') return <p>{describeConflict(verdict)}</p>;
  if (verdict.reason !== 'key_level') return <p>{NO_PLAN_REASONS[verdict.reason]}</p>;
  return (
    <div className="space-y-2">
      <p className="break-words">{describeKeyLevel(verdict, shard)}</p>
      <ul aria-label="What can help" className="list-disc pl-5">
        <li>Client-side caching for the hot keys.</li>
        <li>Reads from replicas.</li>
        <li>Splitting the hot key into several keys.</li>
        {verdict.pinnedSlots.length > 0 && <li>{describeIsolate(verdict.pinnedSlots)}</li>}
      </ul>
    </div>
  );
}

const heldBack = (plan: RebalancePlan): RebalancePlan => ({ ...plan, execution: undefined });

export function RebalanceSuggestion({ connectionId, mode, runnable = true }: Props) {
  const shards = useOpenHotShards(connectionId, { keepOnError: true }).filter(
    (shard) => shard.rebalance && (mode !== 'observe' || shard.rebalance.kind !== 'plan'),
  );
  const [confirmed, setConfirmed] = useState<RebalancePlan | null>(null);
  const current = shards
    .map((shard) => shard.rebalance)
    .find(
      (verdict): verdict is RebalancePlan =>
        verdict?.kind === 'plan' && verdict.sourceShardId === confirmed?.sourceShardId,
    );
  return (
    <>
      {shards.map((shard) => {
        const verdict = shard.rebalance;
        if (!verdict) return null;
        const title = `Suggested rebalance for hot shard ${shortShardId(shard.shardId)} at ${shard.nodeAddr}`;
        return (
          <Card key={shard.eventId} role="region" aria-label={title}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                {title}
                <Badge variant={verdict.kind === 'plan' ? 'default' : 'secondary'}>
                  {verdict.kind === 'no_plan'
                    ? 'No plan'
                    : verdict.effect === 'resolves'
                      ? 'Resolves'
                      : 'Headroom'}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm">
              {verdict.kind === 'plan' ? (
                <Plan plan={runnable ? verdict : heldBack(verdict)} onRun={setConfirmed} />
              ) : (
                <NoPlan verdict={verdict} shard={shard} />
              )}
            </CardContent>
          </Card>
        );
      })}
      {confirmed && (
        <RunDialog
          key={movesKey(confirmed)}
          shown={confirmed}
          current={current && (runnable ? current : heldBack(current))}
          connectionId={connectionId}
          onReview={setConfirmed}
          onClose={() => setConfirmed(null)}
        />
      )}
    </>
  );
}
