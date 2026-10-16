import type Valkey from 'iovalkey';
import { execPipeline } from './pipeline-results';

/**
 * Stream state that XRANGE/XADD does not carry: the stream's own ID counters,
 * its consumer groups, each group's consumers, and each group's pending
 * entries list (PEL). Without it a migrated queue comes up with no groups, and
 * the first XREADGROUP after cutover fails with NOGROUP.
 */
export interface StreamPendingEntry {
  id: string;
  consumer: string;
  idleMs: number;
  deliveries: number;
}

export interface StreamGroupMeta {
  name: string;
  lastDeliveredId: string;
  entriesRead: number | null;
  consumers: string[];
  pending: StreamPendingEntry[];
}

export interface StreamMeta {
  lastGeneratedId: string | null;
  entriesAdded: number | null;
  maxDeletedEntryId: string | null;
  groups: StreamGroupMeta[];
}

const PENDING_PAGE = 1000;
const CLAIM_BATCH = 500;
const PLACEHOLDER_GROUP = '__betterdb_mig_placeholder';

function toRecord(flat: unknown): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  if (!Array.isArray(flat)) return record;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    record[String(flat[i])] = flat[i + 1];
  }
  return record;
}

function asString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value.toString();
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return null;
}

function asNumber(value: unknown): number | null {
  const text = asString(value);
  if (text === null) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

const MAX_SEQ = 18446744073709551615n; // 2^64 - 1

/** Smallest stream ID strictly greater than `id` (XPENDING has no exclusive start before 6.2). */
export function nextStreamId(id: string): string {
  const [ms, seq = '0'] = id.split('-');
  const next = BigInt(seq) + 1n;
  return next > MAX_SEQ ? `${BigInt(ms) + 1n}-0` : `${ms}-${next}`;
}

async function readPending(
  source: Valkey,
  key: string,
  group: string,
): Promise<StreamPendingEntry[]> {
  const pending: StreamPendingEntry[] = [];
  let start = '-';
  for (;;) {
    const page = (await source.call(
      'XPENDING',
      key,
      group,
      start,
      '+',
      String(PENDING_PAGE),
    )) as unknown[];
    if (!Array.isArray(page) || page.length === 0) break;
    for (const row of page) {
      if (!Array.isArray(row) || row.length < 4) continue;
      const id = asString(row[0]);
      const consumer = asString(row[1]);
      if (id === null || consumer === null) continue;
      pending.push({
        id,
        consumer,
        idleMs: asNumber(row[2]) ?? 0,
        deliveries: asNumber(row[3]) ?? 1,
      });
    }
    if (page.length < PENDING_PAGE) break;
    const last = asString((page[page.length - 1] as unknown[])[0]);
    if (last === null) break;
    start = nextStreamId(last);
  }
  return pending;
}

/** Read everything about a stream except its entries. */
export async function readStreamMeta(source: Valkey, key: string): Promise<StreamMeta> {
  const info = toRecord(await source.call('XINFO', 'STREAM', key));
  const meta: StreamMeta = {
    lastGeneratedId: asString(info['last-generated-id']),
    entriesAdded: asNumber(info['entries-added']),
    maxDeletedEntryId: asString(info['max-deleted-entry-id']),
    groups: [],
  };

  const rawGroups = (await source.call('XINFO', 'GROUPS', key)) as unknown;
  if (!Array.isArray(rawGroups)) return meta;
  for (const rawGroup of rawGroups) {
    if (!Array.isArray(rawGroup)) continue;
    const group = toRecord(rawGroup);
    const name = asString(group.name);
    const lastDeliveredId = asString(group['last-delivered-id']);
    if (name === null || lastDeliveredId === null) continue;

    const rawConsumers = (await source.call('XINFO', 'CONSUMERS', key, name)) as unknown;
    const consumers = Array.isArray(rawConsumers)
      ? rawConsumers
          .filter((c): c is unknown[] => Array.isArray(c))
          .map((c) => asString(toRecord(c).name))
          .filter((c): c is string => c !== null)
      : [];

    meta.groups.push({
      name,
      lastDeliveredId,
      entriesRead: asNumber(group['entries-read']),
      consumers,
      pending: await readPending(source, key, name),
    });
  }
  return meta;
}

function isSyntaxError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /syntax error|wrong number of arguments|unknown subcommand/i.test(msg);
}

/**
 * Recreate stream metadata on `writeKey` (the temp key, before RENAME).
 * Falls back to the pre-7.0 forms of XSETID / XGROUP CREATE when the target
 * rejects ENTRIESADDED / MAXDELETEDID / ENTRIESREAD.
 *
 * Returns a warning when some pending entries could not be restored: their
 * message was deleted from the source, or was added and delivered after the
 * entries were copied, so it is not in the copy and XCLAIM ignores it.
 */
export async function writeStreamMeta(
  target: Valkey,
  writeKey: string,
  meta: StreamMeta,
  wroteEntries: boolean,
): Promise<string | undefined> {
  if (!wroteEntries) {
    // Materialize an empty stream: MKSTREAM needs a group, so create and drop a placeholder.
    await target.call('XGROUP', 'CREATE', writeKey, PLACEHOLDER_GROUP, '0', 'MKSTREAM');
    await target.call('XGROUP', 'DESTROY', writeKey, PLACEHOLDER_GROUP);
  }

  if (meta.lastGeneratedId !== null) {
    const extended =
      meta.entriesAdded !== null && meta.maxDeletedEntryId !== null
        ? ['ENTRIESADDED', String(meta.entriesAdded), 'MAXDELETEDID', meta.maxDeletedEntryId]
        : [];
    try {
      await target.call('XSETID', writeKey, meta.lastGeneratedId, ...extended);
    } catch (err) {
      if (extended.length === 0 || !isSyntaxError(err)) throw err;
      await target.call('XSETID', writeKey, meta.lastGeneratedId);
    }
  }

  let lostPending = 0;
  for (const group of meta.groups) {
    const entriesRead =
      group.entriesRead !== null ? ['ENTRIESREAD', String(group.entriesRead)] : [];
    try {
      await target.call(
        'XGROUP',
        'CREATE',
        writeKey,
        group.name,
        group.lastDeliveredId,
        ...entriesRead,
      );
    } catch (err) {
      if (entriesRead.length === 0 || !isSyntaxError(err)) throw err;
      await target.call('XGROUP', 'CREATE', writeKey, group.name, group.lastDeliveredId);
    }

    for (const consumer of group.consumers) {
      try {
        await target.call('XGROUP', 'CREATECONSUMER', writeKey, group.name, consumer);
      } catch (err) {
        // CREATECONSUMER is 6.2+; XCLAIM below still creates consumers that own pending entries.
        if (!isSyntaxError(err)) throw err;
      }
    }

    // XCLAIM … FORCE recreates a PEL entry with its owner, idle time and delivery
    // count. Batched in pipelines; every command targets writeKey, so a cluster
    // client keeps the whole batch on one slot.
    for (let i = 0; i < group.pending.length; i += CLAIM_BATCH) {
      const pipeline = target.pipeline();
      for (const entry of group.pending.slice(i, i + CLAIM_BATCH)) {
        pipeline.call(
          'XCLAIM',
          writeKey,
          group.name,
          entry.consumer,
          '0',
          entry.id,
          'IDLE',
          String(entry.idleMs),
          'RETRYCOUNT',
          String(entry.deliveries),
          'FORCE',
          'JUSTID',
        );
      }
      for (const claimed of await execPipeline(pipeline)) {
        // XCLAIM skips IDs whose message is not in the copy.
        if (!Array.isArray(claimed) || claimed.length === 0) lostPending++;
      }
    }
  }

  return lostPending > 0
    ? `${lostPending} pending entr${lostPending === 1 ? 'y' : 'ies'} not restored (message deleted from the source, or added after the copy)`
    : undefined;
}

/**
 * Compact, order-independent description of a stream's groups, used by validation.
 * Pending counts are left out on purpose: a PEL entry whose message was trimmed
 * from the source cannot be recreated (XCLAIM ignores it), so counts can differ
 * legitimately. The executor logs those per key instead.
 */
export async function describeStreamGroups(client: Valkey, key: string): Promise<string> {
  const rawGroups = (await client.call('XINFO', 'GROUPS', key)) as unknown;
  if (!Array.isArray(rawGroups)) return '';
  return rawGroups
    .filter((g): g is unknown[] => Array.isArray(g))
    .map((g) => {
      const group = toRecord(g);
      return `${asString(group.name)}@${asString(group['last-delivered-id'])}`;
    })
    .sort()
    .join(',');
}
