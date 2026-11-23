import { BadRequestException } from '@nestjs/common';

export const MIN_DURATION_MS = 500;
export const MAX_DURATION_MS = 15 * 60 * 1000;
/** Running rows older than this, and not owned by this process, cannot be live. */
export const ORPHAN_AGE_MS = MAX_DURATION_MS + 2 * 60 * 1000;

export function assertDuration(ms: unknown): number {
  if (
    typeof ms !== 'number' ||
    !Number.isInteger(ms) ||
    ms < MIN_DURATION_MS ||
    ms > MAX_DURATION_MS
  ) {
    throw new BadRequestException(
      `durationMs must be an integer between ${MIN_DURATION_MS} and ${MAX_DURATION_MS}`,
    );
  }
  return ms;
}

export function assertCap(name: 'byteCap' | 'lineCap', v: unknown, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0 || v > max) {
    throw new BadRequestException(`${name} must be a positive integer no greater than ${max}`);
  }
  return v;
}
