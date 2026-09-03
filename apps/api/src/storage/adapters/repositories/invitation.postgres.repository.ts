import type { Pool } from 'pg';
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
  created_at: string | number;
  expires_at: string | number;
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
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
  };
}

export class InvitationPostgresRepository implements InvitationRepository {
  constructor(private readonly pool: Pool) {}

  async findById(id: string): Promise<InvitationRecord | null> {
    return this.one(`${SELECT} WHERE id = $1`, id);
  }

  async findByEmail(email: string): Promise<InvitationRecord | null> {
    return this.one(`${SELECT} WHERE email = $1`, email);
  }

  async findByTokenHash(tokenHash: string): Promise<InvitationRecord | null> {
    return this.one(`${SELECT} WHERE token_hash = $1`, tokenHash);
  }

  async list(): Promise<InvitationRecord[]> {
    const result = await this.pool.query<InvitationRow>(`${SELECT} ORDER BY created_at DESC`);
    return result.rows.map(mapRow);
  }

  async save(record: InvitationRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO invitations (id, email, role, token_hash, invited_by, status, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (email) DO UPDATE SET
         id = EXCLUDED.id,
         role = EXCLUDED.role,
         token_hash = EXCLUDED.token_hash,
         invited_by = EXCLUDED.invited_by,
         status = EXCLUDED.status,
         created_at = EXCLUDED.created_at,
         expires_at = EXCLUDED.expires_at`,
      [
        record.id,
        record.email,
        record.role,
        record.tokenHash,
        record.invitedBy,
        record.status,
        record.createdAt,
        record.expiresAt,
      ],
    );
  }

  async updateStatus(id: string, from: InvitationStatus, to: InvitationStatus): Promise<boolean> {
    const result = await this.pool.query(
      'UPDATE invitations SET status = $1 WHERE id = $2 AND status = $3',
      [to, id, from],
    );
    return result.rowCount === 1;
  }

  private async one(sql: string, value: string): Promise<InvitationRecord | null> {
    const result = await this.pool.query<InvitationRow>(sql, [value]);
    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }
    return mapRow(row);
  }
}
