import type Database from 'better-sqlite3';
import type { CaptureGapCause, CapturedLogType, LogCaptureGap, LogCaptureGapQuery } from '@betterdb/shared';
import {
  clampGapListLimit,
  type LogCaptureGapAggregate,
  type LogCaptureGapRepository,
} from '../../../common/interfaces/log-capture-gap-repository.interface';
import { chunkedSqliteDelete } from '../sqlite-chunked-delete';

interface LogCaptureGapRow {
  id: string;
  connection_id: string;
  log_type: CapturedLogType;
  first_missing_id: number;
  last_missing_id: number;
  missing_count: number;
  cause: CaptureGapCause;
  captured_count: number;
  previous_poll_at: number | null;
  detected_at: number;
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

interface AggregateRow {
  log_type: CapturedLogType;
  cause: CaptureGapCause;
  gap_count: number;
  missing_count: number;
  peak_arrivals: number;
  last_gap_at: number;
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

export class LogCaptureGapSqliteRepository implements LogCaptureGapRepository {
  constructor(private readonly db: Database.Database) {}

  async insert(gap: LogCaptureGap): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO log_capture_gaps (id, connection_id, log_type, first_missing_id, last_missing_id, missing_count, cause, captured_count, previous_poll_at, detected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
      );
  }

  async list(query: LogCaptureGapQuery): Promise<LogCaptureGap[]> {
    const where: string[] = ['connection_id = ?'];
    const params: Array<string | number> = [query.connectionId];
    if (query.logType !== undefined) {
      where.push('log_type = ?');
      params.push(query.logType);
    }
    if (query.since !== undefined) {
      where.push('detected_at >= ?');
      params.push(query.since);
    }
    if (query.until !== undefined) {
      where.push('detected_at <= ?');
      params.push(query.until);
    }
    params.push(clampGapListLimit(query.limit));
    const rows = this.db
      .prepare(
        `SELECT * FROM log_capture_gaps WHERE ${where.join(' AND ')} ORDER BY detected_at DESC, id DESC LIMIT ?`,
      )
      .all(...params) as LogCaptureGapRow[];
    return rows.map(mapRow);
  }

  async summarize(connectionId: string, since: number): Promise<LogCaptureGapAggregate[]> {
    const rows = this.db
      .prepare(
        `SELECT log_type, cause, COUNT(*) AS gap_count, SUM(missing_count) AS missing_count,
                MAX(missing_count + captured_count) AS peak_arrivals, MAX(detected_at) AS last_gap_at
         FROM log_capture_gaps
         WHERE connection_id = ? AND detected_at >= ?
         GROUP BY log_type, cause`,
      )
      .all(connectionId, since) as AggregateRow[];
    return rows.map(mapAggregate);
  }

  async prune(olderThan: number, connectionId?: string): Promise<number> {
    if (connectionId !== undefined) {
      return chunkedSqliteDelete(this.db, 'log_capture_gaps', 'detected_at < ? AND connection_id = ?', [
        olderThan,
        connectionId,
      ]);
    }
    return chunkedSqliteDelete(this.db, 'log_capture_gaps', 'detected_at < ?', [olderThan]);
  }
}
