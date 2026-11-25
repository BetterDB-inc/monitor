import {
  PLACEMENT_MODES,
  type PlacementBalance,
  type PlacementMode,
  type PlacementStatus,
} from '@betterdb/shared';
import { useCanMutate } from '../../hooks/useCanMutate';
import { usePlacement } from '../../hooks/usePlacement';
import { RebalanceSuggestion } from '../anomalies/RebalanceSuggestion';
import { formatRatio } from '../anomalies/anomaly-display';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';

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

function BalanceBars({ balance }: { balance: PlacementBalance | null }) {
  if (!balance) return <p className="text-muted-foreground">No per-slot load sampled yet.</p>;
  const scale = Math.max(
    balance.triggerRatio * BAR_HEADROOM,
    ...balance.shards.map((shard) => shard.ratio ?? 0),
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
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground">
        {`A shard over ${formatRatio(balance.triggerRatio)} the median load is a hot shard; a slot move aims to bring it under ${formatRatio(balance.resolveRatio)}.`}
      </p>
    </div>
  );
}

export function PlacementCard({ connectionId }: { connectionId: string | undefined }) {
  const { licensed, status, error, setMode, saving, modeError } = usePlacement(connectionId);
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
              <EffectiveMode status={status} />
              <Support status={status} />
              <BalanceBars balance={status.balance} />
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
