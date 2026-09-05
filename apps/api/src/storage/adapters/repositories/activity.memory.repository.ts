import type {
  ActivityListQuery,
  ActivityPage,
  ActivityRecord,
  ActivityRepository,
} from '../../../common/interfaces/activity-repository.interface';
import { compareActivityDesc, cursorOf, isBeforeCursor } from './activity-order';

function matches(record: ActivityRecord, query: ActivityListQuery): boolean {
  if (query.actorUserId !== undefined && record.actorUserId !== query.actorUserId) {
    return false;
  }
  if (query.action !== undefined && record.action !== query.action) {
    return false;
  }
  if (query.from !== undefined && record.occurredAt < query.from) {
    return false;
  }
  if (query.to !== undefined && record.occurredAt > query.to) {
    return false;
  }
  if (query.before !== undefined && isBeforeCursor(record, query.before) === false) {
    return false;
  }
  return true;
}

function clone(record: ActivityRecord): ActivityRecord {
  return { ...record, details: { ...record.details } };
}

export class ActivityMemoryRepository implements ActivityRepository {
  private readonly records: ActivityRecord[] = [];

  async insert(record: ActivityRecord): Promise<void> {
    this.records.push(clone(record));
  }

  async list(query: ActivityListQuery): Promise<ActivityPage> {
    const sorted = this.records
      .filter((record) => {
        return matches(record, query);
      })
      .sort(compareActivityDesc);
    const items = sorted.slice(0, query.limit).map(clone);
    if (sorted.length <= query.limit || items.length === 0) {
      return { items, next: null };
    }
    return { items, next: cursorOf(items[items.length - 1]) };
  }

  async prune(before: number): Promise<number> {
    const keep = this.records.filter((record) => {
      return record.occurredAt >= before;
    });
    const removed = this.records.length - keep.length;
    this.records.length = 0;
    this.records.push(...keep);
    return removed;
  }
}
