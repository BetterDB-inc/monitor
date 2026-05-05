import { BadRequestException } from '@nestjs/common';
import type { AppliedResult, StoredCacheProposal } from '@betterdb/shared';

export function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new BadRequestException(`${field} must be a string when provided`);
  }
  return value;
}

export function optionalFiniteNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BadRequestException(`${field} must be a finite number when provided`);
  }
  return value;
}

export interface ApprovalResultPayload {
  proposal_id: string;
  status: string;
  applied_result: AppliedResult | null;
}

export function formatApprovalResult(result: {
  proposal: StoredCacheProposal;
  appliedResult: AppliedResult | null;
}): ApprovalResultPayload {
  return {
    proposal_id: result.proposal.id,
    status: result.proposal.status,
    applied_result: result.appliedResult,
  };
}
