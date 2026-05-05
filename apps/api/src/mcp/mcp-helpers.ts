import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

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
export function safeParseInt(value: string | undefined, defaultValue?: undefined): number | undefined;
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

/** Parse and cap a limit/count query param */
export function safeLimit(value: string | undefined, defaultValue: number): number {
  return Math.max(1, Math.min(safeParseInt(value, defaultValue), MAX_LIMIT));
}

/** Convert ms timestamp query param to seconds. */
export function msToSeconds(value: string | undefined): number | undefined {
  const ms = safeParseInt(value);
  if (ms === undefined || ms < 0) {
    return undefined;
  }
  return Math.floor(ms / 1000);
}
