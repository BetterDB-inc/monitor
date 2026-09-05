import type {
  ActivityCursor,
  ActivityRecord,
} from '../../../common/interfaces/activity-repository.interface';

export function compareActivityDesc(a: ActivityRecord, b: ActivityRecord): number {
  if (a.occurredAt !== b.occurredAt) {
    return b.occurredAt - a.occurredAt;
  }
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? 1 : -1;
}

export function isBeforeCursor(record: ActivityRecord, cursor: ActivityCursor): boolean {
  if (record.occurredAt < cursor.occurredAt) {
    return true;
  }
  return record.occurredAt === cursor.occurredAt && record.id < cursor.id;
}

export function cursorOf(record: ActivityRecord): ActivityCursor {
  return { occurredAt: record.occurredAt, id: record.id };
}
