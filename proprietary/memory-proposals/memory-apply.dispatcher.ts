import { Injectable } from '@nestjs/common';
import { MemoryStore, type MemoryStoreClient } from '@betterdb/agent-memory';
import type { StoredMemoryProposal } from '@betterdb/shared';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';

export interface ApplyOutcome {
  actualAffected: number;
  durationMs: number;
  details: Record<string, unknown>;
}

@Injectable()
export class MemoryApplyDispatcher {
  constructor(private readonly registry: ConnectionRegistry) {}

  async dispatch(proposal: StoredMemoryProposal): Promise<ApplyOutcome> {
    const start = Date.now();
    const client = this.registry
      .get(proposal.connection_id)
      .getClient() as unknown as MemoryStoreClient;
    const store = new MemoryStore({ client, name: proposal.store_name });
    const payload = proposal.proposal_payload;

    if (payload.target_kind === 'id') {
      const removed = await store.forget(payload.memory_id);
      return {
        actualAffected: removed ? 1 : 0,
        durationMs: Date.now() - start,
        details: { target_kind: 'id', memory_id: payload.memory_id, removed },
      };
    }

    const removed = await store.forgetByScope({ ...(payload.scope ?? {}), tags: payload.tags });
    return {
      actualAffected: removed,
      durationMs: Date.now() - start,
      details: {
        target_kind: 'scope',
        scope: payload.scope ?? {},
        tags: payload.tags ?? [],
        removed,
      },
    };
  }
}
