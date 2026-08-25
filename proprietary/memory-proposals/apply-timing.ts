/**
 * How long an `applying` row may sit before the sweep presumes it dead. Well
 * above any realistic forget: sweeping too early marks live work as failed,
 * while sweeping late only leaves a stuck row lingering.
 */
export const STALE_APPLY_AFTER_MS = 15 * 60 * 1000;

/**
 * Hard bound on a single dispatch, strictly below the sweep cutoff so the two
 * can never both claim the same proposal. Without it nothing caps how long a
 * forget runs: a slow one outlives the cutoff, the sweep fails it as stale
 * while the delete is still in flight, and the row leaves `pending` with the
 * target actually gone — so an operator can re-propose and re-apply a forget
 * that already happened.
 */
export const APPLY_DISPATCH_TIMEOUT_MS = 10 * 60 * 1000;

export class MemoryApplyTimeoutError extends Error {
  constructor(proposalId: string, timeoutMs: number) {
    super(`Memory forget for ${proposalId} exceeded ${timeoutMs}ms and was abandoned`);
    this.name = 'MemoryApplyTimeoutError';
  }
}
