import type { ActorVia } from '@betterdb/shared';

export interface ActivityRecord {
  id: string;
  occurredAt: number;
  actorUserId: string;
  actorEmail: string;
  actorVia: ActorVia;
  tokenId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  connectionId: string | null;
  statusCode: number;
  ip: string;
  details: Record<string, unknown>;
}

export interface ActivityCursor {
  occurredAt: number;
  id: string;
}

export interface ActivityListQuery {
  actorUserId?: string;
  from?: number;
  to?: number;
  action?: string;
  before?: ActivityCursor;
  limit: number;
}

export interface ActivityPage {
  items: ActivityRecord[];
  next: ActivityCursor | null;
}

export interface ActivityRepository {
  insert(record: ActivityRecord): Promise<void>;
  list(query: ActivityListQuery): Promise<ActivityPage>;
  prune(before: number): Promise<number>;
}
