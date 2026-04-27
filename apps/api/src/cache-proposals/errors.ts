export type CacheProposalErrorCode =
  | 'VALIDATION_ERROR'
  | 'INVALID_CACHE_TYPE'
  | 'CACHE_NOT_FOUND'
  | 'DUPLICATE_PENDING_PROPOSAL'
  | 'RATE_LIMITED'
  | 'PROPOSAL_NOT_FOUND'
  | 'PROPOSAL_EXPIRED'
  | 'PROPOSAL_NOT_PENDING'
  | 'PROPOSAL_EDIT_NOT_ALLOWED'
  | 'APPLY_FAILED';

export class CacheProposalError extends Error {
  readonly code: CacheProposalErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: CacheProposalErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'CacheProposalError';
    this.code = code;
    this.details = details;
  }
}

export class CacheProposalValidationError extends CacheProposalError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('VALIDATION_ERROR', message, details);
    this.name = 'CacheProposalValidationError';
  }
}

export class InvalidCacheTypeError extends CacheProposalError {
  constructor(expected: string, actual: string, cacheName: string) {
    super(
      'INVALID_CACHE_TYPE',
      `Cache '${cacheName}' is type '${actual}' but tool requires '${expected}'`,
      { expected, actual, cacheName },
    );
    this.name = 'InvalidCacheTypeError';
  }
}

export class CacheNotFoundError extends CacheProposalError {
  constructor(cacheName: string) {
    super(
      'CACHE_NOT_FOUND',
      `Cache '${cacheName}' is not registered in the discovery markers (__betterdb:caches)`,
      { cacheName },
    );
    this.name = 'CacheNotFoundError';
  }
}

export class DuplicatePendingProposalError extends CacheProposalError {
  constructor(cacheName: string, proposalType: string, scope: Record<string, string | null>) {
    super(
      'DUPLICATE_PENDING_PROPOSAL',
      `A pending ${proposalType} proposal already exists for cache '${cacheName}'`,
      { cacheName, proposalType, scope },
    );
    this.name = 'DuplicatePendingProposalError';
  }
}

export class ProposalNotFoundError extends CacheProposalError {
  constructor(proposalId: string) {
    super('PROPOSAL_NOT_FOUND', `Proposal '${proposalId}' not found`, { proposalId });
    this.name = 'ProposalNotFoundError';
  }
}

export class ProposalExpiredError extends CacheProposalError {
  constructor(proposalId: string, expiresAt: number) {
    super(
      'PROPOSAL_EXPIRED',
      `Proposal '${proposalId}' expired at ${new Date(expiresAt).toISOString()}`,
      { proposalId, expiresAt },
    );
    this.name = 'ProposalExpiredError';
  }
}

export class ProposalNotPendingError extends CacheProposalError {
  constructor(proposalId: string, currentStatus: string) {
    super(
      'PROPOSAL_NOT_PENDING',
      `Proposal '${proposalId}' is not pending (current status: '${currentStatus}')`,
      { proposalId, currentStatus },
    );
    this.name = 'ProposalNotPendingError';
  }
}

export class ProposalEditNotAllowedError extends CacheProposalError {
  constructor(proposalId: string, reason: string) {
    super('PROPOSAL_EDIT_NOT_ALLOWED', reason, { proposalId });
    this.name = 'ProposalEditNotAllowedError';
  }
}

export class ApplyFailedError extends CacheProposalError {
  constructor(proposalId: string, message: string, details?: Record<string, unknown>) {
    super('APPLY_FAILED', message, { proposalId, ...details });
    this.name = 'ApplyFailedError';
  }
}

export class RateLimitedError extends CacheProposalError {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number, limit: number, windowMs: number) {
    super(
      'RATE_LIMITED',
      `Proposal rate limit exceeded (${limit} per ${Math.round(windowMs / 60_000)} minutes). Retry after ${Math.round(retryAfterMs / 1000)}s.`,
      { retryAfterMs, limit, windowMs },
    );
    this.name = 'RateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}
