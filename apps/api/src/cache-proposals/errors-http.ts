import { HttpException, HttpStatus } from '@nestjs/common';
import { ZodError } from 'zod';
import {
  ApplyFailedError,
  CacheNotFoundError,
  CacheProposalError,
  CacheProposalValidationError,
  DuplicatePendingProposalError,
  InvalidCacheTypeError,
  ProposalEditNotAllowedError,
  ProposalExpiredError,
  ProposalNotFoundError,
  ProposalNotPendingError,
  RateLimitedError,
} from './errors';

export function mapCacheProposalErrorToHttp(err: unknown): HttpException {
  if (err instanceof HttpException) {
    return err;
  }
  if (err instanceof ZodError) {
    return new HttpException(
      {
        statusCode: HttpStatus.BAD_REQUEST,
        code: 'VALIDATION_ERROR',
        message: 'Request payload failed schema validation',
        issues: err.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
          message: issue.message,
        })),
      },
      HttpStatus.BAD_REQUEST,
    );
  }
  if (err instanceof RateLimitedError) {
    return new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        code: err.code,
        message: err.message,
        retry_after_ms: err.retryAfterMs,
        details: err.details,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
  if (err instanceof ProposalNotFoundError || err instanceof CacheNotFoundError) {
    return errToHttp(err, HttpStatus.NOT_FOUND);
  }
  if (err instanceof DuplicatePendingProposalError) {
    return errToHttp(err, HttpStatus.CONFLICT);
  }
  if (err instanceof ProposalExpiredError || err instanceof ProposalNotPendingError) {
    return errToHttp(err, HttpStatus.CONFLICT);
  }
  if (err instanceof ApplyFailedError) {
    return errToHttp(err, HttpStatus.UNPROCESSABLE_ENTITY);
  }
  if (
    err instanceof InvalidCacheTypeError ||
    err instanceof CacheProposalValidationError ||
    err instanceof ProposalEditNotAllowedError
  ) {
    return errToHttp(err, HttpStatus.BAD_REQUEST);
  }
  if (err instanceof CacheProposalError) {
    return errToHttp(err, HttpStatus.BAD_REQUEST);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new HttpException(
    { statusCode: HttpStatus.INTERNAL_SERVER_ERROR, message },
    HttpStatus.INTERNAL_SERVER_ERROR,
  );
}

function errToHttp(err: CacheProposalError, status: HttpStatus): HttpException {
  return new HttpException(
    {
      statusCode: status,
      code: err.code,
      message: err.message,
      details: err.details,
    },
    status,
  );
}
