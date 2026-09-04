import type { ActorVia } from '@betterdb/shared';
import type { ActivityRecord } from '../common/interfaces/activity-repository.interface';

export interface ActivityActorView {
  userId: string;
  email: string;
  via: ActorVia;
  tokenId: string | null;
}

export interface ActivityTargetView {
  type: string;
  id: string;
}

export interface ActivityView {
  id: string;
  occurredAt: string;
  actor: ActivityActorView;
  action: string;
  target: ActivityTargetView | null;
  connectionId: string | null;
  statusCode: number;
  ip: string;
  details: Record<string, unknown>;
}

export interface ActivityPageView {
  items: ActivityView[];
  nextCursor: string | null;
}

function targetOf(record: ActivityRecord): ActivityTargetView | null {
  if (record.targetType === null || record.targetId === null) {
    return null;
  }
  return { type: record.targetType, id: record.targetId };
}

export function toActivityView(record: ActivityRecord): ActivityView {
  return {
    id: record.id,
    occurredAt: new Date(record.occurredAt).toISOString(),
    actor: {
      userId: record.actorUserId,
      email: record.actorEmail,
      via: record.actorVia,
      tokenId: record.tokenId,
    },
    action: record.action,
    target: targetOf(record),
    connectionId: record.connectionId,
    statusCode: record.statusCode,
    ip: record.ip,
    details: record.details,
  };
}

export function parseIsoTime(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  return Date.parse(value);
}
