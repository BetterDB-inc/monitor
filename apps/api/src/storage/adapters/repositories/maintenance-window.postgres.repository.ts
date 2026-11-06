import type { Pool } from 'pg';
import type { MaintenanceWindow, WebhookEventType } from '@betterdb/shared';
import type { MaintenanceWindowRepository } from '../../../common/interfaces/maintenance-window-repository.interface';
import { chunkedPostgresDelete } from '../postgres-chunked-delete';

interface MaintenanceWindowRow {
  id: string;
  name: string;
  reason: string | null;
  connection_id: string | null;
  events: string;
  starts_at: string | number;
  ends_at: string | number;
  ended_at: string | number | null;
  created_by: string | null;
  created_at: string | number;
  updated_at: string | number;
}

function mapRow(row: MaintenanceWindowRow): MaintenanceWindow {
  return {
    id: row.id,
    name: row.name,
    reason: row.reason,
    connectionId: row.connection_id,
    events: JSON.parse(row.events) as WebhookEventType[],
    startsAt: Number(row.starts_at),
    endsAt: Number(row.ends_at),
    endedAt: row.ended_at === null ? null : Number(row.ended_at),
    createdBy: row.created_by,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class MaintenanceWindowPostgresRepository implements MaintenanceWindowRepository {
  constructor(private readonly pool: Pool) {}

  async list(): Promise<MaintenanceWindow[]> {
    const result = await this.pool.query<MaintenanceWindowRow>(
      'SELECT * FROM maintenance_windows ORDER BY starts_at DESC, id DESC',
    );
    return result.rows.map(mapRow);
  }

  async get(id: string): Promise<MaintenanceWindow | null> {
    const result = await this.pool.query<MaintenanceWindowRow>(
      'SELECT * FROM maintenance_windows WHERE id = $1',
      [id],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapRow(row);
  }

  async save(window: MaintenanceWindow): Promise<void> {
    await this.pool.query(
      `INSERT INTO maintenance_windows (id, name, reason, connection_id, events, starts_at, ends_at, ended_at, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         reason = EXCLUDED.reason,
         connection_id = EXCLUDED.connection_id,
         events = EXCLUDED.events,
         starts_at = EXCLUDED.starts_at,
         ends_at = EXCLUDED.ends_at,
         ended_at = EXCLUDED.ended_at,
         created_by = EXCLUDED.created_by,
         updated_at = EXCLUDED.updated_at`,
      [
        window.id,
        window.name,
        window.reason,
        window.connectionId,
        JSON.stringify(window.events),
        window.startsAt,
        window.endsAt,
        window.endedAt,
        window.createdBy,
        window.createdAt,
        window.updatedAt,
      ],
    );
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM maintenance_windows WHERE id = $1', [id]);
    return result.rowCount === 1;
  }

  async prune(endedBefore: number): Promise<number> {
    return chunkedPostgresDelete(
      this.pool,
      'maintenance_windows',
      'LEAST(ends_at, COALESCE(ended_at, ends_at)) < $1',
      [endedBefore],
    );
  }
}
