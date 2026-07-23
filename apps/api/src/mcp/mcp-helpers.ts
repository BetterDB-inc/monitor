import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  PipeTransform,
} from '@nestjs/common';
import { CapabilityUnavailableError } from '../common/errors/capability-unavailable.error';

export const INSTANCE_ID_RE = /^[a-zA-Z0-9_-]+$/;
export const MAX_LIMIT = 10000;

@Injectable()
export class ValidateInstanceIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!INSTANCE_ID_RE.test(value)) {
      throw new BadRequestException('Invalid instance ID');
    }
    return value;
  }
}

export function safeParseInt(value: string | undefined, defaultValue: number): number;
export function safeParseInt(
  value: string | undefined,
  defaultValue?: undefined,
): number | undefined;
export function safeParseInt(value: string | undefined, defaultValue?: number): number | undefined {
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    return defaultValue;
  }
  return parsed;
}

/** Parse and cap a limit/count query param, clamping into [1, max]. Fractional values round up. */
export function safeLimit(
  value: string | undefined,
  defaultValue: number,
  max = MAX_LIMIT,
): number {
  if (value === undefined || value.trim() === '') {
    return defaultValue;
  }
  const parsed = Number(value);
  if (Number.isFinite(parsed) === false) {
    return defaultValue;
  }
  return Math.max(1, Math.min(Math.ceil(parsed), max));
}

/** Convert ms timestamp query param to seconds. */
export function msToSeconds(value: string | undefined): number | undefined {
  const ms = safeParseInt(value);
  if (ms === undefined || ms < 0) {
    return undefined;
  }
  return Math.floor(ms / 1000);
}

export function mapMcpError(logger: Logger, error: unknown, fallback: string): HttpException {
  if (error instanceof HttpException) {
    return error;
  }
  if (error instanceof CapabilityUnavailableError) {
    return new HttpException(error.message, HttpStatus.NOT_IMPLEMENTED);
  }
  logger.error(fallback, error instanceof Error ? error.stack : String(error));
  const detail = error instanceof Error && error.message !== '' ? `: ${error.message}` : '';
  return new HttpException(`${fallback}${detail}`, HttpStatus.INTERNAL_SERVER_ERROR);
}
