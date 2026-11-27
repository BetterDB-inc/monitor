import {
  PLACEMENT_MODES,
  type PlacementBalance,
  type PlacementMode,
  type PlacementBlocker,
  type PlacementPolicyInvalid,
  type PlacementSettings,
  type PlacementStatus,
} from '@betterdb/shared';
import { useState } from 'react';
import { useCanMutate } from '../../hooks/useCanMutate';
import { usePlacement } from '../../hooks/usePlacement';
import { RebalanceSuggestion } from '../anomalies/RebalanceSuggestion';
import { REBALANCE_BLOCKED, formatRatio } from '../anomalies/anomaly-display';
import type { RebalanceExecutionBlocker } from '../../types/anomaly';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { PlacementPolicyDrawer } from './PlacementPolicyDrawer';

const MODE_LABELS: Record<PlacementMode, string> = {
  observe: 'Observe',
  recommend: 'Recommend',
  approve: 'Approve',
  auto: 'Auto',
};

const MODE_HINTS: Record<PlacementMode, string> = {
  observe: 'Shows load and imbalance, and why a shard cannot be fixed by moving slots.',
  recommend: 'Shows a plan with the projected load. A plan runs only when an admin starts it.',
  approve: 'Runs a proposed move after an admin approves it.',
  auto: 'Runs moves without approval when every policy rule allows it.',
};

const LATER: readonly PlacementMode[] = ['approve', 'auto'];

function highestSupported(status: PlacementStatus): PlacementMode {
  return (
    [...PLACEMENT_MODES].reverse().find((mode) => status.support.modes[mode].available) ?? 'observe'
  );
}

function ModeSelector({
  status,
  saving,
  onSelect,
}: {
  status: PlacementStatus;
  saving: boolean;
  onSelect: (mode: PlacementMode) => void;
}) {
  const canMutate = useCanMutate();
  return (
    <div className="space-y-1">
      <div role="group" aria-label="Placement mode" className="flex flex-wrap gap-2">
        {PLACEMENT_MODES.map((mode) => {
          const current = status.mode === mode;
          const selectable = status.selectableModes.includes(mode);
          return (
            <Button
              key={mode}
              size="sm"
              variant={current ? 'default' : 'outline'}
              aria-pressed={current}
              title={MODE_HINTS[mode]}
              disabled={!canMutate || saving || (!current && !selectable) || LATER.includes(mode)}
              onClick={() => {
                if (!current) onSelect(mode);
              }}
            >
              {MODE_LABELS[mode]}
            </Button>
          );
        })}
      </div>
      <p className="text-muted-foreground">{MODE_HINTS[status.mode]}</p>
      <p className="text-muted-foreground">Approve and Auto come in a later release.</p>
    </div>
  );
}

function EffectiveMode({ status }: { status: PlacementStatus }) {
  if (status.effectiveMode === status.mode) return null;
  const blockedBy = status.support.modes[status.mode].blockedBy;
  const issue = status.support.issues.find((each) => each.reason === blockedBy);
  return (
    <p className="text-yellow-600 dark:text-yellow-500">
      {`${MODE_LABELS[status.mode]} is set, but this cluster runs as ${MODE_LABELS[status.effectiveMode]}`}
      {issue ? `: ${issue.detail}` : '.'}
    </p>
  );
}

function Support({ status }: { status: PlacementStatus }) {
  if (status.support.issues.length === 0) return null;
  return (
    <ul aria-label="What limits placement" className="list-disc pl-5 text-muted-foreground">
      {status.support.issues.map((issue) => (
        <li key={issue.reason}>{issue.detail}</li>
      ))}
    </ul>
  );
}

const BAR_HEADROOM = 1.25;

function clockTime(at: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

function SustainLine({ shard }: { shard: PlacementBalance['shards'][number] }) {
  if (shard.sustainRatio === null) return null;
  const baseline =
    shard.baselineRatio === null ? '' : `, ${formatRatio(shard.baselineRatio)} over 6 hours`;
  return (
    <p className="text-xs text-muted-foreground">
      {shard.trigger !== 'short_history'
        ? `Sustained ${formatRatio(shard.sustainRatio)} the median${baseline}`
        : shard.warmUntil === null
          ? 'Warming up'
          : `Warming up until ${clockTime(shard.warmUntil)}`}
    </p>
  );
}

function triggerSentence(balance: PlacementBalance, settings: PlacementSettings): string {
  const share =
    settings.maxCpuShare === null
      ? ''
      : `, or above ${Math.round(settings.maxCpuShare * 100)}% of the cluster CPU,`;
  return `The trigger for slot moves fires only when the sustained load stays over ${formatRatio(balance.triggerRatio)}${share} for ${settings.sustainMinutes} minutes.`;
}

function BalanceBars({
  balance,
  settings,
}: {
  balance: PlacementBalance | null;
  settings: PlacementSettings;
}) {
  if (!balance) return <p className="text-muted-foreground">No per-slot load sampled yet.</p>;
  const scale = Math.max(
    balance.triggerRatio * BAR_HEADROOM,
    ...balance.shards.map((shard) => Math.max(shard.ratio ?? 0, shard.sustainRatio ?? 0)),
  );
  const at = (ratio: number) => `${Math.min(100, (ratio / scale) * 100)}%`;
  return (
    <div className="space-y-2">
      {balance.settling && (
        <p className="text-muted-foreground">
          Slots changed owner and the load is still being measured.
        </p>
      )}
      <ul aria-label="Load against the median" className="space-y-2">
        {balance.shards.map((shard) => (
          <li key={shard.shardId} className="space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono">{shard.address}</span>
              <span className="flex items-center gap-2 text-muted-foreground">
                {shard.ratio === null ? 'No slots' : `${formatRatio(shard.ratio)} the median`}
                {shard.overTrigger && <Badge variant="destructive">Over the trigger</Badge>}
                {shard.trigger === 'over' && <Badge variant="destructive">Sustained</Badge>}
              </span>
            </div>
            <div className="relative h-2 rounded bg-muted" aria-hidden="true">
              <div
                className={`h-2 rounded ${shard.overTrigger ? 'bg-destructive' : 'bg-primary'}`}
                style={{ width: at(shard.ratio ?? 0) }}
              />
              <div
                className="absolute top-[-2px] h-3 w-px bg-foreground/60"
                style={{ left: at(balance.triggerRatio) }}
              />
            </div>
            {shard.sustainRatio !== null && (
              <div className="h-1 rounded bg-muted" aria-hidden="true">
                <div
                  className={`h-1 rounded ${shard.trigger === 'over' ? 'bg-destructive' : 'bg-primary/60'}`}
                  style={{ width: at(shard.sustainRatio) }}
                />
              </div>
            )}
            <SustainLine shard={shard} />
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground">
        {`A shard over ${formatRatio(balance.triggerRatio)} the median load is a hot shard; a slot move aims to bring it under ${formatRatio(balance.resolveRatio)}. ${triggerSentence(balance, settings)}`}
      </p>
    </div>
  );
}

function PolicyInvalid({ invalid }: { invalid: PlacementPolicyInvalid | null }) {
  if (!invalid) return null;
  return (
    <div role="alert" className="space-y-1 rounded-md border border-destructive/50 p-3">
      <p className="font-medium text-destructive">The stored placement policy is invalid.</p>
      <p className="text-muted-foreground">
        {invalid.exclusionsReadable
          ? 'The fields below use their defaults until the policy is saved again; the exclusions are kept.'
          : 'The excluded shards and slots cannot be read, so no slot moves are suggested until the policy is saved again.'}
      </p>
      <ul className="list-disc pl-5 text-muted-foreground">
        {invalid.problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
    </div>
  );
}

function BlockerList({
  label,
  items,
  className,
}: {
  label: string;
  items: PlacementBlocker[];
  className: string;
}) {
  if (items.length === 0) return null;
  return (
    <ul aria-label={label} className={`list-disc pl-5 ${className}`}>
      {items.map((item) => (
        <li key={`${item.kind} ${item.scope} ${item.nodeId ?? ''} ${item.detail}`}>
          {item.detail}
        </li>
      ))}
    </ul>
  );
}

function Recommendations({ status }: { status: PlacementStatus }) {
  if (status.recommendations.length === 0) return null;
  const address = (shardId: string) =>
    status.balance?.shards.find((shard) => shard.shardId === shardId)?.address ?? shardId;
  return (
    <ul aria-label="Suggested slot moves" className="space-y-2">
      {status.recommendations.map((recommendation) => (
        <li key={recommendation.sourceShardId} className="space-y-1">
          <p>
            {`Move slots from ${address(recommendation.sourceShardId)} to ${recommendation.targetShardIds.map(address).join(', ')}.`}
          </p>
          {!recommendation.execution.available && (
            <p className="text-muted-foreground">
              {REBALANCE_BLOCKED[recommendation.execution.blockedBy as RebalanceExecutionBlocker] ??
                'Cannot run from this monitor.'}
            </p>
          )}
          {recommendation.gate.allowed ? (
            recommendation.execution.available && (
              <p className="text-muted-foreground">Would run now.</p>
            )
          ) : (
            <>
              <p className="text-muted-foreground">Waits for:</p>
              <BlockerList
                label="Placement blockers"
                items={recommendation.gate.blockers}
                className="text-muted-foreground"
              />
            </>
          )}
          <BlockerList
            label="Placement warnings"
            items={recommendation.gate.warnings}
            className="text-yellow-600 dark:text-yellow-500"
          />
        </li>
      ))}
    </ul>
  );
}

export function PlacementCard({ connectionId }: { connectionId: string | undefined }) {
  return <ClusterPlacementCard key={connectionId ?? ''} connectionId={connectionId} />;
}

function ClusterPlacementCard({ connectionId }: { connectionId: string | undefined }) {
  const { licensed, status, error, setMode, saving, modeError, savePolicy } =
    usePlacement(connectionId);
  const canMutate = useCanMutate();
  const [policyOpen, setPolicyOpen] = useState(false);
  if (!licensed || !connectionId) return null;
  return (
    <>
      <Card role="region" aria-label="Slot placement">
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-lg">
            Slot placement
            {status && (
              <Badge variant="secondary">{`Supports up to ${MODE_LABELS[highestSupported(status)]}`}</Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {!status && !error && (
            <p className="text-muted-foreground">Reading the placement status…</p>
          )}
          {!status && error && (
            <p className="text-muted-foreground">Could not read the placement status.</p>
          )}
          {status && (
            <>
              <ModeSelector status={status} saving={saving} onSelect={setMode} />
              {modeError && (
                <p role="alert" className="text-destructive">
                  {modeError.message}
                </p>
              )}
              <PolicyInvalid invalid={status.policyInvalid} />
              <EffectiveMode status={status} />
              <Support status={status} />
              <BalanceBars balance={status.balance} settings={status.settings} />
              <Recommendations status={status} />
              <Button size="sm" variant="outline" onClick={() => setPolicyOpen(true)}>
                {canMutate ? 'Edit policy' : 'View policy'}
              </Button>
              <PlacementPolicyDrawer
                open={policyOpen}
                onOpenChange={setPolicyOpen}
                settings={status.settings}
                version={status.policyVersion}
                onSave={savePolicy}
              />
            </>
          )}
        </CardContent>
      </Card>
      {status && (
        <RebalanceSuggestion
          connectionId={connectionId}
          mode={status.effectiveMode}
          runnable={!error}
        />
      )}
    </>
  );
}
