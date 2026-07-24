import { ScanSkewOffender, ScanSkewReport } from '@betterdb/shared';
import { StoredCommandLogEntry } from '../common/interfaces/storage-port.interface';

/**
 * SCAN large-reply / hash-skew analysis (valkey#3955): SCAN-family commands can
 * return vastly more elements than the requested COUNT when a key's hashtable
 * degenerates into a long single-bucket chain (scan-delete + linear reinsert
 * workloads; the upstream repro saw 4,979 items for COUNT 1). We cannot see
 * element counts — the persisted large-reply magnitude is the reply size in
 * BYTES — so the skew signal is bytes-per-requested-element against a tunable
 * budget, weighted by recurrence per key.
 */

/** Tunable per-element byte budget: replies above this per requested element are suspicious. */
export const SCAN_SKEW_BYTES_PER_ELEMENT = 4096;
/** A single sighting at or above budget × this multiplier is surfaced without recurrence. */
export const SCAN_SKEW_EXTREME_MULTIPLIER = 10;
/** Ordinary over-budget sightings require this many occurrences before surfacing. */
export const SCAN_SKEW_MIN_SIGHTINGS = 2;

const KEYED_SCAN_VERBS = new Set(['SSCAN', 'HSCAN', 'ZSCAN']);

export interface ParsedScanCommand {
  verb: string;
  /** Scanned key; null for the keyless keyspace SCAN. */
  key: string | null;
  /** Requested COUNT (server default 10 when absent). */
  count: number;
}

export type { ScanSkewOffender, ScanSkewReport };

/**
 * Parse a SCAN-family command (SCAN/SSCAN/HSCAN/ZSCAN) into its scanned key
 * and requested COUNT. Returns null for anything else. Handles MATCH before or
 * after COUNT, HSCAN's NOVALUES flag, SCAN's TYPE argument, and the implicit
 * COUNT default of 10.
 */
export function parseScanCommand(command: string[]): ParsedScanCommand | null {
  if (command.length === 0) {
    return null;
  }
  const verb = command[0].toUpperCase();

  let key: string | null;
  let argsStart: number;
  if (verb === 'SCAN') {
    key = null;
    argsStart = 2;
  } else if (KEYED_SCAN_VERBS.has(verb)) {
    key = command[1] ?? '';
    argsStart = 3;
  } else {
    return null;
  }

  let count = 10;
  for (let i = argsStart; i < command.length; i += 1) {
    const token = command[i].toUpperCase();
    if (token === 'COUNT') {
      const parsed = parseInt(command[i + 1] ?? '', 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        count = parsed;
      }
      i += 1;
      continue;
    }
    if (token === 'MATCH' || token === 'TYPE') {
      i += 1;
      continue;
    }
    // NOVALUES and unknown flags carry no value — skip.
  }

  return { verb, key, count };
}

function scanMatchPattern(command: string[]): string | null {
  for (let i = 0; i < command.length - 1; i += 1) {
    if (command[i].toUpperCase() === 'MATCH') {
      return command[i + 1];
    }
  }
  return null;
}

interface OffenderAccumulator {
  verb: string;
  sightings: number;
  worstBytesPerElement: number;
  totalBytes: number;
  lastTimestamp: number;
}

/**
 * Analyse persisted large-reply commandlog entries for SCAN-family replies
 * whose byte size is disproportionate to the requested COUNT. Only entries of
 * type 'large-reply' are considered (their `duration` column is the reply size
 * in bytes). Offenders are ranked worst-first by bytes-per-requested-element.
 */
export function analyzeScanSkew(entries: StoredCommandLogEntry[]): ScanSkewReport {
  const byKey = new Map<string, OffenderAccumulator>();
  let entriesAnalyzed = 0;

  for (const item of entries) {
    if (item.type !== 'large-reply') {
      continue;
    }
    const parsed = parseScanCommand(item.command);
    if (parsed === null) {
      continue;
    }
    entriesAnalyzed += 1;

    const bytesPerElement = item.duration / parsed.count;
    if (bytesPerElement < SCAN_SKEW_BYTES_PER_ELEMENT) {
      continue;
    }

    const groupKey =
      parsed.key !== null ? parsed.key : `SCAN ${scanMatchPattern(item.command) ?? '*'}`;
    const existing = byKey.get(groupKey);
    if (existing === undefined) {
      byKey.set(groupKey, {
        verb: parsed.verb,
        sightings: 1,
        worstBytesPerElement: bytesPerElement,
        totalBytes: item.duration,
        lastTimestamp: item.timestamp,
      });
    } else {
      existing.sightings += 1;
      existing.totalBytes += item.duration;
      existing.worstBytesPerElement = Math.max(existing.worstBytesPerElement, bytesPerElement);
      existing.lastTimestamp = Math.max(existing.lastTimestamp, item.timestamp);
    }
  }

  const extremeThreshold = SCAN_SKEW_BYTES_PER_ELEMENT * SCAN_SKEW_EXTREME_MULTIPLIER;
  const offenders: ScanSkewOffender[] = [];
  for (const [key, acc] of byKey) {
    const isExtreme = acc.worstBytesPerElement >= extremeThreshold;
    if (acc.sightings < SCAN_SKEW_MIN_SIGHTINGS && isExtreme === false) {
      continue;
    }
    offenders.push({
      key,
      verb: acc.verb,
      sightings: acc.sightings,
      worstBytesPerElement: Math.round(acc.worstBytesPerElement),
      totalBytes: acc.totalBytes,
      lastTimestamp: acc.lastTimestamp,
      message:
        `${acc.verb} replies on ${key} far exceed the requested COUNT ` +
        `(~${Math.round(acc.worstBytesPerElement / 1024)}KB per requested element) — possible ` +
        `degenerate hash chain (valkey#3955). Consider re-creating the key, or upgrade once the ` +
        `upstream fix lands.`,
    });
  }

  offenders.sort((a, b) => {
    return b.worstBytesPerElement - a.worstBytesPerElement;
  });

  return { offenders, entriesAnalyzed };
}
