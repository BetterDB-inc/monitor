export class MemoryProposalError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class MemoryProposalValidationError extends MemoryProposalError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'memory_proposal_validation_error', details);
  }
}

export class DuplicatePendingMemoryProposalError extends MemoryProposalError {
  constructor(details?: Record<string, unknown>) {
    super('A pending forget proposal already exists for this target', 'duplicate_pending', details);
  }
}

export class MemoryProposalNotFoundError extends MemoryProposalError {
  constructor(proposalId: string) {
    super(`Memory proposal not found: ${proposalId}`, 'not_found', { proposalId });
  }
}

export class MemoryProposalNotPendingError extends MemoryProposalError {
  constructor(proposalId: string) {
    super(`Memory proposal is not pending: ${proposalId}`, 'not_pending', { proposalId });
  }
}

export class MemoryProposalExpiredError extends MemoryProposalError {
  constructor(proposalId: string) {
    super(`Memory proposal has expired: ${proposalId}`, 'expired', { proposalId });
  }
}

export class MemoryApplyFailedError extends MemoryProposalError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'apply_failed', details);
  }
}

export class MemoryProposalRateLimitedError extends MemoryProposalError {
  constructor(retryAfterMs: number, limit: number, windowMs: number) {
    super('Too many forget proposals; slow down', 'rate_limited', {
      retryAfterMs,
      limit,
      windowMs,
    });
  }
}
