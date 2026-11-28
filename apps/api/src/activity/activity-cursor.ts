import type { ActivityCursor } from '../common/interfaces/activity-repository.interface';
import { decodeKeysetCursor, encodeKeysetCursor } from '../common/utils/keyset-cursor';

export function encodeActivityCursor(cursor: ActivityCursor): string {
  return encodeKeysetCursor(cursor.occurredAt, cursor.id);
}

export function decodeActivityCursor(raw: string): ActivityCursor | null {
  const cursor = decodeKeysetCursor(raw);
  return cursor && { occurredAt: cursor.at, id: cursor.id };
}
