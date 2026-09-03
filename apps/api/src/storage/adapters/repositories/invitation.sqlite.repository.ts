import type Database from 'better-sqlite3';
import type {
  InvitationRecord,
  InvitationRepository,
  InvitationStatus,
} from '../../../common/interfaces/invitation-repository.interface';

interface InvitationRow {
  id: string;
  email: string;
  role: InvitationRecord['role'];
  token_hash: string;
  invited_by: string;
  status: InvitationStatus;
  created_at: number;
  expires_at: number;
}

const SELECT = 'SELECT * FROM invitations';

function mapRow(row: InvitationRow): InvitationRecord {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    tokenHash: row.token_hash,
    invitedBy: row.invited_by,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export class InvitationSqliteRepository implements InvitationRepository {
  constructor(private readonly db: Database.Database) {}

  async findById(id: string): Promise<InvitationRecord | null> {
    return this.one(`${SELECT} WHERE id = ?`, id);
  }

  async findByEmail(email: string): Promise<InvitationRecord | null> {
    return this.one(`${SELECT} WHERE email = ?`, email);
  }

  async findByTokenHash(tokenHash: string): Promise<InvitationRecord | null> {
    return this.one(`${SELECT} WHERE token_hash = ?`, tokenHash);
  }

  async list(): Promise<InvitationRecord[]> {
    const rows = this.db.prepare(`${SELECT} ORDER BY created_at DESC`).all() as InvitationRow[];
    return rows.map(mapRow);
  }

  async save(record: InvitationRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO invitations (id, email, role, token_hash, invited_by, status, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET
           id = excluded.id,
           role = excluded.role,
           token_hash = excluded.token_hash,
           invited_by = excluded.invited_by,
           status = excluded.status,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at`,
      )
      .run(
        record.id,
        record.email,
        record.role,
        record.tokenHash,
        record.invitedBy,
        record.status,
        record.createdAt,
        record.expiresAt,
      );
  }

  async updateStatus(id: string, from: InvitationStatus, to: InvitationStatus): Promise<boolean> {
    const result = this.db
      .prepare('UPDATE invitations SET status = ? WHERE id = ? AND status = ?')
      .run(to, id, from);
    return result.changes === 1;
  }

  private one(sql: string, value: string): InvitationRecord | null {
    const row = this.db.prepare(sql).get(value) as InvitationRow | undefined;
    if (row === undefined) {
      return null;
    }
    return mapRow(row);
  }
}
