import type Database from 'better-sqlite3';
import type { MaintenanceWindow, WebhookEventType } from '@betterdb/shared';
import type { MaintenanceWindowRepository } from '../../../common/interfaces/maintenance-window-repository.interface';
import { chunkedSqliteDelete } from '../sqlite-chunked-delete';

interface MaintenanceWindowRow {
  id: string;
  name: string;
  reason: string | null;
  connection_id: string | null;
  events: string;
  starts_at: number;
  ends_at: number;
  ended_at: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
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

export class MaintenanceWindowSqliteRepository implements MaintenanceWindowRepository {
  constructor(private readonly db: Database.Database) {}

  async list(): Promise<MaintenanceWindow[]> {
    const rows = this.db
      .prepare('SELECT * FROM maintenance_windows ORDER BY starts_at DESC, id DESC')
      .all() as MaintenanceWindowRow[];
    return rows.map(mapRow);
  }

  async get(id: string): Promise<MaintenanceWindow | null> {
    const row = this.db.prepare('SELECT * FROM maintenance_windows WHERE id = ?').get(id) as
      | MaintenanceWindowRow
      | undefined;
    return row === undefined ? null : mapRow(row);
  }

  async save(window: MaintenanceWindow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO maintenance_windows (id, name, reason, connection_id, events, starts_at, ends_at, ended_at, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           reason = excluded.reason,
           connection_id = excluded.connection_id,
           events = excluded.events,
           starts_at = excluded.starts_at,
           ends_at = excluded.ends_at,
           ended_at = excluded.ended_at,
           created_by = excluded.created_by,
           updated_at = excluded.updated_at`,
      )
      .run(
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
      );
  }

  async delete(id: string): Promise<boolean> {
    return this.db.prepare('DELETE FROM maintenance_windows WHERE id = ?').run(id).changes === 1;
  }

  async prune(endedBefore: number): Promise<number> {
    return chunkedSqliteDelete(
      this.db,
      'maintenance_windows',
      'MIN(ends_at, COALESCE(ended_at, ends_at)) < ?',
      [endedBefore],
    );
  }
}
