import type { AgentToolTtlAdjustPayload } from '@betterdb/shared';
import { formatTtlSeconds } from '../../../../lib/formatters';

interface Props {
  payload: AgentToolTtlAdjustPayload;
}

export function AgentTtlBody({ payload }: Props) {
  return (
    <dl className="text-sm grid grid-cols-[7rem_1fr] gap-y-1">
      <dt className="text-muted-foreground">Tool:</dt>
      <dd className="font-mono">{payload.tool_name}</dd>
      <dt className="text-muted-foreground">Current:</dt>
      <dd>ttl={formatTtlSeconds(payload.current_ttl_seconds)}</dd>
      <dt className="text-muted-foreground">Proposed:</dt>
      <dd>ttl={formatTtlSeconds(payload.new_ttl_seconds)}</dd>
    </dl>
  );
}
