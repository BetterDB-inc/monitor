import { Injectable } from '@nestjs/common';
import { MemoryStore, type MemoryStoreClient } from '@betterdb/agent-memory';
import type { StoredMemoryProposal } from '@betterdb/shared';
import { ConnectionRegistry } from '@app/connections/connection-registry.service';
import { APPLY_DISPATCH_TIMEOUT_MS, MemoryApplyTimeoutError } from './apply-timing';

export interface ApplyOutcome {
  actualAffected: number;
  durationMs: number;
  details: Record<string, unknown>;
}

@Injectable()
export class MemoryApplyDispatcher {
  private timeoutMs = APPLY_DISPATCH_TIMEOUT_MS;

  constructor(private readonly registry: ConnectionRegistry) {}

  configureForTesting(options: { timeoutMs?: number }): void {
    if (options.timeoutMs !== undefined) {
      this.timeoutMs = options.timeoutMs;
    }
  }

  async dispatch(proposal: StoredMemoryProposal): Promise<ApplyOutcome> {
    // Bounded so a dispatch always terminates before the stale sweep could
    // consider it dead. The forget itself cannot be cancelled, so a timeout
    // abandons it and records a failure rather than claiming a clean result.
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new MemoryApplyTimeoutError(proposal.id, this.timeoutMs));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([this.run(proposal), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async run(proposal: StoredMemoryProposal): Promise<ApplyOutcome> {
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
