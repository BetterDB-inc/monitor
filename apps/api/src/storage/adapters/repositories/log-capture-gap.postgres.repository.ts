import type { Pool } from 'pg';
import type { CaptureGapCause, CapturedLogType, LogCaptureGap, LogCaptureGapQuery } from '@betterdb/shared';
import {
  clampGapListLimit,
  type LogCaptureGapAggregate,
  type LogCaptureGapRepository,
} from '../../../common/interfaces/log-capture-gap-repository.interface';
import { chunkedPostgresDelete } from '../postgres-chunked-delete';

interface LogCaptureGapRow {
  id: string;
  connection_id: string;
  log_type: CapturedLogType;
  first_missing_id: string | number;
  last_missing_id: string | number;
  missing_count: string | number;
  cause: CaptureGapCause;
  captured_count: string | number;
  previous_poll_at: string | number | null;
  detected_at: string | number;
}

function mapRow(row: LogCaptureGapRow): LogCaptureGap {
  return {
    id: row.id,
    connectionId: row.connection_id,
    logType: row.log_type,
    firstMissingId: Number(row.first_missing_id),
    lastMissingId: Number(row.last_missing_id),
    missingCount: Number(row.missing_count),
    cause: row.cause,
    capturedCount: Number(row.captured_count),
    previousPollAt: row.previous_poll_at === null ? null : Number(row.previous_poll_at),
    detectedAt: Number(row.detected_at),
  };
}

/** COUNT/SUM/MAX over BIGINT come back from pg as strings. */
interface AggregateRow {
  log_type: CapturedLogType;
  cause: CaptureGapCause;
  gap_count: string | number;
  missing_count: string | number;
  peak_arrivals: string | number;
  last_gap_at: string | number;
}

function mapAggregate(row: AggregateRow): LogCaptureGapAggregate {
  return {
    logType: row.log_type,
    cause: row.cause,
    gapCount: Number(row.gap_count),
    missingCount: Number(row.missing_count),
    peakArrivals: Number(row.peak_arrivals),
    lastGapAt: Number(row.last_gap_at),
  };
}

export class LogCaptureGapPostgresRepository implements LogCaptureGapRepository {
  constructor(private readonly pool: Pool) {}

  async insert(gap: LogCaptureGap): Promise<void> {
    await this.pool.query(
      `INSERT INTO log_capture_gaps (id, connection_id, log_type, first_missing_id, last_missing_id, missing_count, cause, captured_count, previous_poll_at, detected_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        gap.id,
        gap.connectionId,
        gap.logType,
        gap.firstMissingId,
        gap.lastMissingId,
        gap.missingCount,
        gap.cause,
        gap.capturedCount,
        gap.previousPollAt,
        gap.detectedAt,
      ],
    );
  }

  async list(query: LogCaptureGapQuery): Promise<LogCaptureGap[]> {
    const where: string[] = ['connection_id = $1'];
    const params: Array<string | number> = [query.connectionId];
    if (query.logType !== undefined) {
      params.push(query.logType);
      where.push(`log_type = $${params.length}`);
    }
    if (query.since !== undefined) {
      params.push(query.since);
      where.push(`detected_at >= $${params.length}`);
    }
    if (query.until !== undefined) {
      params.push(query.until);
      where.push(`detected_at <= $${params.length}`);
    }
    params.push(clampGapListLimit(query.limit));
    const result = await this.pool.query<LogCaptureGapRow>(
      `SELECT * FROM log_capture_gaps WHERE ${where.join(' AND ')} ORDER BY detected_at DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    return result.rows.map(mapRow);
  }

  async summarize(connectionId: string, since: number): Promise<LogCaptureGapAggregate[]> {
    const result = await this.pool.query<AggregateRow>(
      `SELECT log_type, cause, COUNT(*) AS gap_count, SUM(missing_count) AS missing_count,
              MAX(missing_count + captured_count) AS peak_arrivals, MAX(detected_at) AS last_gap_at
       FROM log_capture_gaps
       WHERE connection_id = $1 AND detected_at >= $2
       GROUP BY log_type, cause`,
      [connectionId, since],
    );
    return result.rows.map(mapAggregate);
  }

  async prune(olderThan: number, connectionId?: string): Promise<number> {
    if (connectionId !== undefined) {
      return chunkedPostgresDelete(this.pool, 'log_capture_gaps', 'detected_at < $1 AND connection_id = $2', [
        olderThan,
        connectionId,
      ]);
    }
    return chunkedPostgresDelete(this.pool, 'log_capture_gaps', 'detected_at < $1', [olderThan]);
  }
}
