import type Database from 'better-sqlite3';
import type {
  ActivityListQuery,
  ActivityPage,
  ActivityRecord,
  ActivityRepository,
} from '../../../common/interfaces/activity-repository.interface';
import { cursorOf } from './activity-order';

interface ActivityRow {
  id: string;
  occurred_at: number;
  actor_user_id: string;
  actor_email: string;
  actor_via: ActivityRecord['actorVia'];
  token_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  connection_id: string | null;
  status_code: number;
  ip: string;
  details: string;
}

const COLUMNS =
  'id, occurred_at, actor_user_id, actor_email, actor_via, token_id, action, target_type, target_id, connection_id, status_code, ip, details';

function parseDetails(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && Array.isArray(parsed) === false) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function mapRow(row: ActivityRow): ActivityRecord {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    actorUserId: row.actor_user_id,
    actorEmail: row.actor_email,
    actorVia: row.actor_via,
    tokenId: row.token_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    connectionId: row.connection_id,
    statusCode: row.status_code,
    ip: row.ip,
    details: parseDetails(row.details),
  };
}

interface Filter {
  where: string[];
  params: Array<string | number>;
}

function buildFilter(query: ActivityListQuery): Filter {
  const filter: Filter = { where: [], params: [] };
  if (query.actorUserId !== undefined) {
    filter.where.push('actor_user_id = ?');
    filter.params.push(query.actorUserId);
  }
  if (query.action !== undefined) {
    filter.where.push('action = ?');
    filter.params.push(query.action);
  }
  if (query.from !== undefined) {
    filter.where.push('occurred_at >= ?');
    filter.params.push(query.from);
  }
  if (query.to !== undefined) {
    filter.where.push('occurred_at <= ?');
    filter.params.push(query.to);
  }
  if (query.before !== undefined) {
    filter.where.push('(occurred_at < ? OR (occurred_at = ? AND id < ?))');
    filter.params.push(query.before.occurredAt, query.before.occurredAt, query.before.id);
  }
  return filter;
}

export class ActivitySqliteRepository implements ActivityRepository {
  constructor(private readonly db: Database.Database) {}

  async insert(record: ActivityRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO activity_events (${COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.occurredAt,
        record.actorUserId,
        record.actorEmail,
        record.actorVia,
        record.tokenId,
        record.action,
        record.targetType,
        record.targetId,
        record.connectionId,
        record.statusCode,
        record.ip,
        JSON.stringify(record.details),
      );
  }

  async list(query: ActivityListQuery): Promise<ActivityPage> {
    const filter = buildFilter(query);
    const whereSql = filter.where.length > 0 ? `WHERE ${filter.where.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM activity_events ${whereSql}
         ORDER BY occurred_at DESC, id DESC LIMIT ?`,
      )
      .all(...filter.params, query.limit + 1) as ActivityRow[];
    const items = rows.slice(0, query.limit).map(mapRow);
    if (rows.length <= query.limit || items.length === 0) {
      return { items, next: null };
    }
    return { items, next: cursorOf(items[items.length - 1]) };
  }

  async prune(before: number): Promise<number> {
    const result = this.db.prepare('DELETE FROM activity_events WHERE occurred_at < ?').run(before);
    return result.changes;
  }
}
