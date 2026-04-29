import type { AgentInvalidatePayload } from '@betterdb/shared';

const HIGH_IMPACT_THRESHOLD = 10000;

const FILTER_KIND_LABELS: Record<AgentInvalidatePayload['filter_kind'], string> = {
  tool: 'Tool',
  key_prefix: 'Key prefix',
  session: 'Session',
};

interface Props {
  payload: AgentInvalidatePayload;
}

export function AgentInvalidateBody({ payload }: Props) {
  const isHighImpact = payload.estimated_affected > HIGH_IMPACT_THRESHOLD;
  return (
    <dl className="text-sm grid grid-cols-[7rem_1fr] gap-y-1">
      <dt className="text-muted-foreground">{FILTER_KIND_LABELS[payload.filter_kind]}:</dt>
      <dd className="font-mono">{payload.filter_value}</dd>
      <dt className="text-muted-foreground">Affected:</dt>
      <dd
        data-testid="estimated-affected"
        data-warn={isHighImpact ? 'true' : 'false'}
        className={
          isHighImpact ? 'text-[color:var(--chart-warning)] font-semibold' : undefined
        }
      >
        ~{payload.estimated_affected.toLocaleString()} entries
        {isHighImpact && (
          <span className="ml-2 text-xs uppercase tracking-wide">High impact</span>
        )}
      </dd>
    </dl>
  );
}
