import type {
  InvitationRecord,
  InvitationRepository,
  InvitationStatus,
} from '../../../common/interfaces/invitation-repository.interface';

export class InvitationMemoryRepository implements InvitationRepository {
  private readonly byEmail = new Map<string, InvitationRecord>();

  clear(): void {
    this.byEmail.clear();
  }

  async findById(id: string): Promise<InvitationRecord | null> {
    return this.find((record) => {
      return record.id === id;
    });
  }

  async findByEmail(email: string): Promise<InvitationRecord | null> {
    const record = this.byEmail.get(email);
    if (record === undefined) {
      return null;
    }
    return { ...record };
  }

  async findByTokenHash(tokenHash: string): Promise<InvitationRecord | null> {
    return this.find((record) => {
      return record.tokenHash === tokenHash;
    });
  }

  async list(): Promise<InvitationRecord[]> {
    return Array.from(this.byEmail.values())
      .sort((a, b) => {
        return b.createdAt - a.createdAt;
      })
      .map((record) => {
        return { ...record };
      });
  }

  async save(record: InvitationRecord): Promise<void> {
    this.byEmail.set(record.email, { ...record });
  }

  async updateStatus(id: string, from: InvitationStatus, to: InvitationStatus): Promise<boolean> {
    const record = this.find((candidate) => {
      return candidate.id === id;
    });
    if (record === null) {
      return false;
    }
    if (record.status !== from) {
      return false;
    }
    this.byEmail.set(record.email, { ...record, status: to });
    return true;
  }

  private find(predicate: (record: InvitationRecord) => boolean): InvitationRecord | null {
    for (const record of this.byEmail.values()) {
      if (predicate(record) === true) {
        return { ...record };
      }
    }
    return null;
  }
}
