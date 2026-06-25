import { HttpException, HttpStatus } from '@nestjs/common';
import {
  MemoryProposalError,
  MemoryProposalValidationError,
  DuplicatePendingMemoryProposalError,
  MemoryProposalNotFoundError,
  MemoryProposalNotPendingError,
  MemoryProposalExpiredError,
  MemoryApplyFailedError,
  MemoryProposalRateLimitedError,
} from './errors';

export function mapMemoryProposalErrorToHttp(err: unknown): HttpException {
  if (err instanceof HttpException) {
    return err;
  }
  if (err instanceof MemoryProposalValidationError) {
    return new HttpException(body(err), HttpStatus.BAD_REQUEST);
  }
  if (err instanceof DuplicatePendingMemoryProposalError) {
    return new HttpException(body(err), HttpStatus.CONFLICT);
  }
  if (err instanceof MemoryProposalNotFoundError) {
    return new HttpException(body(err), HttpStatus.NOT_FOUND);
  }
  if (
    err instanceof MemoryProposalNotPendingError ||
    err instanceof MemoryProposalExpiredError
  ) {
    return new HttpException(body(err), HttpStatus.CONFLICT);
  }
  if (err instanceof MemoryProposalRateLimitedError) {
    return new HttpException(body(err), HttpStatus.TOO_MANY_REQUESTS);
  }
  if (err instanceof MemoryApplyFailedError) {
    return new HttpException(body(err), HttpStatus.UNPROCESSABLE_ENTITY);
  }
  if (err instanceof MemoryProposalError) {
    return new HttpException(body(err), HttpStatus.BAD_REQUEST);
  }
  const message = err instanceof Error ? err.message : 'Unexpected error';
  return new HttpException({ error: message, code: 'internal_error' }, HttpStatus.INTERNAL_SERVER_ERROR);
}

function body(err: MemoryProposalError): Record<string, unknown> {
  return { error: err.message, code: err.code, details: err.details };
}
