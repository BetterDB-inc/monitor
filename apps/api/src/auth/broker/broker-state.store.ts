import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { loadBetterAuthDate } from '../better-auth-esm';
import { BETTER_AUTH, type BetterAuthInstance } from '../better-auth.factory';

export const BROKER_STATE_TTL_MS = 10 * 60 * 1000;
const STATE_BYTES = 32;
const STATE_PREFIX = 'broker-state:';

export interface BrokerStateRecord {
  origin: string;
  appOrigin: string;
  next: string;
  inviteTokenHash: string | null;
}

function parseRecord(value: string): BrokerStateRecord | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const record = parsed as Partial<BrokerStateRecord>;
    if (typeof record.origin !== 'string' || typeof record.appOrigin !== 'string') {
      return null;
    }
    if (typeof record.next !== 'string') {
      return null;
    }
    const inviteTokenHash =
      typeof record.inviteTokenHash === 'string' ? record.inviteTokenHash : null;
    return {
      origin: record.origin,
      appOrigin: record.appOrigin,
      next: record.next,
      inviteTokenHash,
    };
  } catch {
    return null;
  }
}

@Injectable()
export class BrokerStateStore {
  constructor(@Inject(BETTER_AUTH) private readonly auth: BetterAuthInstance) {}

  async create(record: BrokerStateRecord): Promise<string> {
    const state = randomBytes(STATE_BYTES).toString('base64url');
    const context = await this.auth.$context;
    const BetterAuthDate = await loadBetterAuthDate();
    await context.internalAdapter.createVerificationValue({
      identifier: `${STATE_PREFIX}${state}`,
      value: JSON.stringify(record),
      expiresAt: new BetterAuthDate(Date.now() + BROKER_STATE_TTL_MS),
    });
    return state;
  }

  async consume(state: string): Promise<BrokerStateRecord | null> {
    const context = await this.auth.$context;
    const row = await context.internalAdapter.consumeVerificationValue(`${STATE_PREFIX}${state}`);
    if (row === null) {
      return null;
    }
    if (new Date(row.expiresAt).getTime() <= Date.now()) {
      return null;
    }
    return parseRecord(row.value);
  }
}
