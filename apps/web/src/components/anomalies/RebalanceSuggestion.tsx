import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useOpenHotShards } from '../../hooks/useOpenHotShards';
import { copyToClipboard } from '../../lib/clipboard';
import type {
  HotShardDetail,
  RebalanceCommand,
  RebalanceMove,
  RebalanceNoPlan,
  RebalanceNoPlanReason,
  RebalancePinnedSlot,
  RebalancePlan,
  RebalanceSupport,
  RebalanceWarning,
} from '../../types/anomaly';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';

const COPIED_FOR_MS = 2000;

interface Props {
  connectionId: string | undefined;
}

const short = (shardId: string) => shardId.substring(0, 8);
const percent = (share: number) => `${Math.round(share * 100)}%`;
const ofCore = (cpuUsecPerSecond: number) => percent(cpuUsecPerSecond / 1_000_000);
const ratio = (value: number) => `${Number(value.toFixed(2))}x`;
const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumSignificantDigits: 2 });
const keys = (count: number) => compact.format(count).toLowerCase();

function listed(parts: string[]): string {
  if (parts.length < 2) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function describeMove(move: RebalanceMove): string {
  const ranges = move.ranges.map(([start, end]) =>
    start === end ? `${start}` : `${start}-${end}`,
  );
  const single = move.slotCount === 1;
  return (
    `Move slot${single ? '' : 's'} ${listed(ranges)} ` +
    `(${move.slotCount} slot${single ? '' : 's'}, ${percent(move.shareOfShard)} of this shard's CPU, ` +
    `about ${keys(move.keyCount)} keys) to shard ${short(move.targetShardId)} at ${move.targetAddr}.`
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
  const shard = `shard ${short(warning.shardId)}`;
  switch (warning.code) {
    case 'source_fork':
      return 'The hot shard forks to send the slots, while it is the busiest node.';
    case 'fewer_replicas':
      return `Shard ${short(warning.shardId)} has fewer replicas than the hot shard.`;
    case 'target_memory':
      return `Shard ${short(warning.shardId)} would be at about ${percent(warning.memoryShare ?? 0)} of its memory limit after the move.`;
    case 'memory_unknown':
      return `The memory room of ${shard} is not known.`;
  }
}

const NO_COMMAND: Record<Exclude<RebalanceSupport, 'valkey_atomic' | 'redis_atomic'>, string> = {
  none: 'This server version has no single command that moves slots: that needs Valkey 9.0 or Redis 8.4 on every shard of the plan. BetterDB does not script the manual SETSLOT and MIGRATE steps; the slots above are for resharding by hand.',
  provider_managed:
    "Slot commands are not supported on this managed service. Use your provider's resharding with the slots above.",
  unknown: 'The server version could not be read, so no command is shown.',
};

const NO_PLAN_REASONS: Record<Exclude<RebalanceNoPlanReason, 'key_level'>, string> = {
  cluster_hot: 'No other shard has room for this load. Consider adding a shard.',
  too_many_targets: 'This load would have to be spread over too many shards for one suggestion.',
  no_target: 'No other primary can take slots.',
  unhealthy_node:
    'A primary is failed or suspect. A suggestion comes back when every primary is healthy.',
  migration_running:
    'A slot migration is running, or the monitor could not ask every primary whether one is. A suggestion comes back when no migration is running and every primary answers.',
  settling: 'Slots changed owner and the load is still being measured.',
  slots_scattered: "This shard's slots are too scattered to move enough load in a few ranges.",
};

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
    (key ? ` Its hottest key is "${key.key}".` : '')
  );
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

function Commands({ plan }: { plan: RebalancePlan }) {
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
        BetterDB does not run it.
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

function Plan({ plan }: { plan: RebalancePlan }) {
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
              ? `This brings the shard from ${ratio(source.before.ratio)} to ${ratio(source.after.ratio)} the median.`
              : `This frees ${percent(moved)} of the shard's CPU. The shard stays at ${ratio(source.after.ratio)} the median, but the load that stays has more of the node to itself.`}
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
                  <span className="font-mono">{short(row.shardId)}</span>{' '}
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
                  {ratio(row.before.ratio)} → {ratio(row.after.ratio)}
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
      </div>
      {plan.warnings.length > 0 && (
        <ul aria-label="Warnings" className="list-disc pl-5 text-yellow-600 dark:text-yellow-500">
          {plan.warnings.map((warning) => (
            <li key={`${warning.code} ${warning.shardId}`}>{describeWarning(warning)}</li>
          ))}
        </ul>
      )}
      <Commands plan={plan} />
    </div>
  );
}

function NoPlan({ verdict, shard }: { verdict: RebalanceNoPlan; shard: HotShardDetail }) {
  if (verdict.reason !== 'key_level') return <p>{NO_PLAN_REASONS[verdict.reason]}</p>;
  return (
    <div className="space-y-2">
      <p>{describeKeyLevel(verdict, shard)}</p>
      <ul aria-label="What can help" className="list-disc pl-5">
        <li>Client-side caching for the hot keys.</li>
        <li>Reads from replicas.</li>
        <li>Splitting the hot key into several keys.</li>
      </ul>
    </div>
  );
}

export function RebalanceSuggestion({ connectionId }: Props) {
  const shards = useOpenHotShards(connectionId).filter((shard) => shard.rebalance);
  return (
    <>
      {shards.map((shard) => {
        const verdict = shard.rebalance;
        if (!verdict) return null;
        const title = `Suggested rebalance for hot shard ${short(shard.shardId)} at ${shard.nodeAddr}`;
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
                <Plan plan={verdict} />
              ) : (
                <NoPlan verdict={verdict} shard={shard} />
              )}
            </CardContent>
          </Card>
        );
      })}
    </>
  );
}
