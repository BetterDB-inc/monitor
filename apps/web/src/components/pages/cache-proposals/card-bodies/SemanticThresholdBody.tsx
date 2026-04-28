import type { SemanticThresholdAdjustPayload } from '@betterdb/shared';

interface Props {
  payload: SemanticThresholdAdjustPayload;
}

export function SemanticThresholdBody({ payload }: Props) {
  const categoryLabel = payload.category ? ` for category '${payload.category}'` : '';
  return (
    <dl className="text-sm grid grid-cols-[7rem_1fr] gap-y-1">
      <dt className="text-muted-foreground">Current:</dt>
      <dd>
        threshold={payload.current_threshold}
        {categoryLabel}
      </dd>
      <dt className="text-muted-foreground">Proposed:</dt>
      <dd>threshold={payload.new_threshold}</dd>
    </dl>
  );
}
