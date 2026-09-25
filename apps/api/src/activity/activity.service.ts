import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Actor, ActorVia } from '@betterdb/shared';
import type {
  ActivityCursor,
  ActivityRecord,
} from '../common/interfaces/activity-repository.interface';
import type { StoragePort } from '../common/interfaces/storage-port.interface';
import { ACTIVITY_CONFIG, ActivityConfig } from './activity-config';
import { decodeActivityCursor, encodeActivityCursor } from './activity-cursor';

export const INVALID_CURSOR_MESSAGE = 'Invalid cursor';
export const MAX_PAGE_SIZE = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ActivityActor {
  userId: string;
  email: string;
  via: ActorVia;
  tokenId: string | null;
}

export interface ActivityInput {
  actor: ActivityActor;
  action: string;
  statusCode: number;
  ip: string;
  connectionId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  details?: Record<string, unknown>;
}

export interface ActivityListParams {
  actorUserId?: string;
  from?: number;
  to?: number;
  action?: string;
  cursor?: string;
  limit?: number;
}

export interface ActivityListResult {
  items: ActivityRecord[];
  nextCursor: string | null;
}

export function toActivityActor(actor: Actor): ActivityActor {
  return { userId: actor.userId, email: actor.email, via: actor.via, tokenId: actor.tokenId };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isFinite(limit) === false) {
    return MAX_PAGE_SIZE;
  }
  return Math.min(Math.max(Math.floor(limit), 1), MAX_PAGE_SIZE);
}

function decodeCursor(cursor: string | undefined): ActivityCursor | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  const decoded = decodeActivityCursor(cursor);
  if (decoded === null) {
    throw new BadRequestException(INVALID_CURSOR_MESSAGE);
  }
  return decoded;
}

@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);

  constructor(
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
    @Inject(ACTIVITY_CONFIG) private readonly config: ActivityConfig,
  ) {}

  async record(input: ActivityInput): Promise<void> {
    const record: ActivityRecord = {
      id: randomUUID(),
      occurredAt: Date.now(),
      actorUserId: input.actor.userId,
      actorEmail: input.actor.email,
      actorVia: input.actor.via,
      tokenId: input.actor.tokenId,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      connectionId: input.connectionId ?? null,
      statusCode: input.statusCode,
      ip: input.ip,
      details: input.details ?? {},
    };
    try {
      await this.storage.getActivityRepository().insert(record);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Activity write failed for ${input.action}: ${message}`);
    }
  }

  async list(params: ActivityListParams): Promise<ActivityListResult> {
    const page = await this.storage.getActivityRepository().list({
      actorUserId: params.actorUserId,
      from: params.from,
      to: params.to,
      action: params.action,
      before: decodeCursor(params.cursor),
      limit: clampLimit(params.limit),
    });
    return {
      items: page.items,
      nextCursor: page.next === null ? null : encodeActivityCursor(page.next),
    };
  }

  async prune(now: number = Date.now()): Promise<number> {
    const boundary = now - this.config.retentionDays * DAY_MS;
    return this.storage.getActivityRepository().prune(boundary);
  }
}
