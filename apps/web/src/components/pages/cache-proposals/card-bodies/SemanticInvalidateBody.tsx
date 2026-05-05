import type { SemanticInvalidatePayload } from '@betterdb/shared';

const HIGH_IMPACT_THRESHOLD = 10000;

interface Props {
  payload: SemanticInvalidatePayload;
}

export function SemanticInvalidateBody({ payload }: Props) {
  const isHighImpact = payload.estimated_affected > HIGH_IMPACT_THRESHOLD;
  return (
    <div className="text-sm space-y-2">
      <div>
        <div className="text-muted-foreground mb-1">Filter:</div>
        <pre className="font-mono text-xs bg-muted px-2 py-1.5 rounded border border-border whitespace-pre-wrap break-all">
          {payload.filter_expression}
        </pre>
      </div>
      <div className="grid grid-cols-[7rem_1fr] gap-y-1">
        <span className="text-muted-foreground">Affected:</span>
        <span
          data-testid="estimated-affected"
          data-warn={isHighImpact ? 'true' : 'false'}
          className={
            isHighImpact
              ? 'text-[color:var(--chart-warning)] font-semibold'
              : undefined
          }
        >
          ~{payload.estimated_affected.toLocaleString()} entries
          {isHighImpact && (
            <span className="ml-2 text-xs uppercase tracking-wide">High impact</span>
          )}
        </span>
      </div>
    </div>
  );
}
