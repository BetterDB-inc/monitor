import type { Pool } from 'pg';
import type {
  ActivityListQuery,
  ActivityPage,
  ActivityRecord,
  ActivityRepository,
} from '../../../common/interfaces/activity-repository.interface';
import { cursorOf } from './activity-order';

interface ActivityRow {
  id: string;
  occurred_at: string | number;
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
    occurredAt: Number(row.occurred_at),
    actorUserId: row.actor_user_id,
    actorEmail: row.actor_email,
    actorVia: row.actor_via,
    tokenId: row.token_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    connectionId: row.connection_id,
    statusCode: Number(row.status_code),
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
  const next = (): string => {
    return `$${filter.params.length}`;
  };
  if (query.actorUserId !== undefined) {
    filter.params.push(query.actorUserId);
    filter.where.push(`actor_user_id = ${next()}`);
  }
  if (query.action !== undefined) {
    filter.params.push(query.action);
    filter.where.push(`action = ${next()}`);
  }
  if (query.from !== undefined) {
    filter.params.push(query.from);
    filter.where.push(`occurred_at >= ${next()}`);
  }
  if (query.to !== undefined) {
    filter.params.push(query.to);
    filter.where.push(`occurred_at <= ${next()}`);
  }
  if (query.before !== undefined) {
    filter.params.push(query.before.occurredAt);
    const at = next();
    filter.params.push(query.before.id);
    const id = next();
    filter.where.push(`(occurred_at < ${at} OR (occurred_at = ${at} AND id < ${id}))`);
  }
  return filter;
}

export class ActivityPostgresRepository implements ActivityRepository {
  constructor(private readonly pool: Pool) {}

  async insert(record: ActivityRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO activity_events (${COLUMNS})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
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
      ],
    );
  }

  async list(query: ActivityListQuery): Promise<ActivityPage> {
    const filter = buildFilter(query);
    const whereSql = filter.where.length > 0 ? `WHERE ${filter.where.join(' AND ')}` : '';
    const limitIndex = filter.params.length + 1;
    const result = await this.pool.query<ActivityRow>(
      `SELECT ${COLUMNS} FROM activity_events ${whereSql}
       ORDER BY occurred_at DESC, id DESC LIMIT $${limitIndex}`,
      [...filter.params, query.limit + 1],
    );
    const items = result.rows.slice(0, query.limit).map(mapRow);
    if (result.rows.length <= query.limit || items.length === 0) {
      return { items, next: null };
    }
    return { items, next: cursorOf(items[items.length - 1]) };
  }

  async prune(before: number): Promise<number> {
    const result = await this.pool.query('DELETE FROM activity_events WHERE occurred_at < $1', [
      before,
    ]);
    return result.rowCount ?? 0;
  }
}
