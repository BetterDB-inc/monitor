import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  PipeTransform,
} from '@nestjs/common';
import { CapabilityUnavailableError } from '../common/errors/capability-unavailable.error';
import { ExternalConnectionUnsupportedError } from '../external-metrics/external-connection-unsupported.error';

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
  const clamp = (candidate: number): number => {
    return Math.max(1, Math.min(Math.ceil(candidate), max));
  };
  if (value === undefined || value.trim() === '') {
    return clamp(defaultValue);
  }
  const parsed = Number(value);
  if (Number.isFinite(parsed) === false) {
    return clamp(defaultValue);
  }
  return clamp(parsed);
}

/** Convert ms timestamp query param to seconds. */
export function msToSeconds(value: string | undefined): number | undefined {
  const ms = safeParseInt(value);
  if (ms === undefined || ms < 0) {
    return undefined;
  }
  return Math.floor(ms / 1000);
}

export function mapMcpError(
  logger: Logger,
  error: unknown,
  fallback: string,
  logMessage: string = fallback,
): HttpException {
  if (error instanceof ExternalConnectionUnsupportedError) {
    throw error;
  }
  if (error instanceof HttpException) {
    return error;
  }
  if (error instanceof CapabilityUnavailableError) {
    return new HttpException(error.message, HttpStatus.NOT_IMPLEMENTED);
  }
  logger.error(logMessage, error instanceof Error ? error.stack : String(error));
  return new HttpException(fallback, HttpStatus.INTERNAL_SERVER_ERROR);
}

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === '';
}

/**
 * Resolve an optional [startTime, endTime] millisecond range for MCP history
 * routes. A missing endTime means "now"; a missing startTime means
 * `defaultLookbackMs` before endTime. Inverted, non-integer, negative or
 * wider-than-`maxSpanMs` ranges are rejected with 400 so an agent gets a
 * clear error instead of a silently clamped answer.
 */
export function resolveTimeRange(
  startTime: string | undefined,
  endTime: string | undefined,
  defaultLookbackMs: number,
  maxSpanMs: number,
  now: number = Date.now(),
): { from: number; to: number } {
  const to = isBlank(endTime) ? now : Number(endTime);
  const from = isBlank(startTime) ? Math.max(0, to - defaultLookbackMs) : Number(startTime);
  if (Number.isSafeInteger(from) === false || Number.isSafeInteger(to) === false) {
    throw new BadRequestException('startTime and endTime must be integer millisecond timestamps');
  }
  if (from < 0 || to < 0) {
    throw new BadRequestException('startTime and endTime must not be negative');
  }
  if (from > to) {
    throw new BadRequestException('startTime must be less than or equal to endTime');
  }
  if (to - from > maxSpanMs) {
    throw new BadRequestException(
      `time range must not exceed ${Math.round(maxSpanMs / HOUR_MS)} hours`,
    );
  }
  return { from, to };
}

/** Largest logical-database index accepted by MCP routes (sanity bound, not a Valkey limit). */
export const MAX_DB_INDEX = 65_535;

/** Parse an optional logical-database index query param; 400 on anything but an integer in [0, MAX_DB_INDEX]. */
export function parseOptionalDbIndex(value: string | undefined): number | undefined {
  if (isBlank(value)) {
    return undefined;
  }
  const parsed = Number(value);
  if (Number.isInteger(parsed) === false || parsed < 0 || parsed > MAX_DB_INDEX) {
    throw new BadRequestException(`db must be an integer between 0 and ${MAX_DB_INDEX}`);
  }
  return parsed;
}

const URL_USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]+@/gi;

/** Strip `user:pass@` userinfo from every URL embedded in free text (error messages, logs). */
export function redactUrlCredentials(text: string): string {
  return text.replace(URL_USERINFO_RE, '$1');
}

/**
 * Reduce a scrape URL to scheme://host/path. Drops userinfo, query string and
 * fragment, the places a token could be embedded. Falls back to regex redaction
 * when the value does not parse as a URL.
 */
export function redactScrapeUrl(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return redactUrlCredentials(raw.split(/[?#]/)[0]);
  }
}

/** Default and ceiling for `maxPoints` on MCP history routes (agent context budget). */
export const DEFAULT_MAX_POINTS = 150;
export const MAX_MAX_POINTS = 1000;

/** Parse `maxPoints`; blank → default, integer in [2, MAX_MAX_POINTS] otherwise 400. */
export function parseMaxPoints(value: string | undefined): number {
  if (isBlank(value)) {
    return DEFAULT_MAX_POINTS;
  }
  const parsed = Number(value);
  if (Number.isInteger(parsed) === false || parsed < 2 || parsed > MAX_MAX_POINTS) {
    throw new BadRequestException(`maxPoints must be an integer between 2 and ${MAX_MAX_POINTS}`);
  }
  return parsed;
}

export interface SamplingInfo {
  originalPoints: number;
  returnedPoints: number;
  maxPoints: number;
  /** none: nothing dropped; rebucketed: service aggregated into wider buckets; even: evenly spaced subset of the original points. */
  method: 'none' | 'rebucketed' | 'even';
  /** Series dropped entirely because there were more series than maxPoints. */
  omittedSeries?: number;
}

/**
 * Evenly spaced subset of `points`, always keeping the first and last.
 * Every returned element is an original point, unchanged.
 */
export function downsampleEvenly<T>(points: readonly T[], maxPoints: number): T[] {
  if (points.length <= maxPoints) {
    return [...points];
  }
  const step = (points.length - 1) / (maxPoints - 1);
  const out: T[] = [];
  for (let i = 0; i < maxPoints; i++) {
    out.push(points[Math.round(i * step)]);
  }
  return out;
}

/** Sampling block for a single series downsampled with {@link downsampleEvenly}. */
export function evenSampling(originalPoints: number, returnedPoints: number, maxPoints: number): SamplingInfo {
  return {
    originalPoints,
    returnedPoints,
    maxPoints,
    method: returnedPoints === originalPoints ? 'none' : 'even',
  };
}

/**
 * Downsample several interleaved series (e.g. per engine × model) so the
 * TOTAL returned never exceeds `maxPoints`. Each series gets an equal share
 * of floor(maxPoints / series). With a share of 2 or more, each series keeps
 * its first and last point. With a share of 1, each series keeps only its
 * latest point. With more series than `maxPoints`, only the first `maxPoints`
 * series (input order) keep their latest point and the rest are counted in
 * `sampling.omittedSeries`. Series order and the order within each series are
 * preserved.
 */
export function downsampleSeries<T>(
  rows: readonly T[],
  seriesKey: (row: T) => string,
  maxPoints: number,
): { rows: T[]; sampling: SamplingInfo } {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = seriesKey(row);
    const list = groups.get(key);
    if (list) {
      list.push(row);
    } else {
      groups.set(key, [row]);
    }
  }
  const perSeries = Math.floor(maxPoints / Math.max(1, groups.size));
  const out: T[] = [];
  let omittedSeries = 0;
  if (perSeries >= 2) {
    for (const list of groups.values()) {
      out.push(...downsampleEvenly(list, perSeries));
    }
  } else {
    for (const list of groups.values()) {
      if (out.length < maxPoints) {
        out.push(list[list.length - 1]);
      } else {
        omittedSeries++;
      }
    }
  }
  const sampling = evenSampling(rows.length, out.length, maxPoints);
  if (omittedSeries > 0) {
    sampling.omittedSeries = omittedSeries;
  }
  return { rows: out, sampling };
}
