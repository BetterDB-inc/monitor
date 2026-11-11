import {
  nodeAddressKeys,
  normalizeNodeAvailabilityZones,
  type NodeAvailabilityZones,
} from '@betterdb/shared';
import type { ClusterNode } from '../../types/metrics';

export type ZoneLinesResult =
  | { ok: true; zones: NodeAvailabilityZones }
  | { ok: false; error: string };

export function formatZoneLines(
  nodes: ClusterNode[],
  zones: NodeAvailabilityZones | undefined,
): string {
  const remaining = new Map(Object.entries(zones ?? {}));
  const lines: string[] = [];
  for (const node of nodes) {
    const keys = nodeAddressKeys(node);
    const configured = keys.find((key) => remaining.has(key));
    if (configured) {
      lines.push(`${configured}=${remaining.get(configured)}`);
      remaining.delete(configured);
    } else if (keys.length > 0 && !node.availabilityZone) {
      lines.push(`${keys[0]}=`);
    }
  }
  for (const [address, zone] of remaining) {
    lines.push(`${address}=${zone}`);
  }
  return lines.join('\n');
}

export function parseZoneLines(text: string): ZoneLinesResult {
  const zones: NodeAvailabilityZones = {};
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) {
      continue;
    }
    const prefix = `Line ${index + 1}: `;
    const separator = line.indexOf('=');
    if (separator === -1) {
      return { ok: false, error: `${prefix}expected host:port=zone` };
    }
    const zone = line.slice(separator + 1).trim();
    if (!zone) {
      continue;
    }
    const entry = normalizeNodeAvailabilityZones({ [line.slice(0, separator)]: zone });
    if (!entry.ok) {
      return { ok: false, error: `${prefix}${entry.error}` };
    }
    const [address, normalizedZone] = Object.entries(entry.zones ?? {})[0];
    if (address in zones) {
      return { ok: false, error: `${prefix}Duplicate node address '${address}'` };
    }
    zones[address] = normalizedZone;
  }
  const all = normalizeNodeAvailabilityZones(zones);
  return all.ok ? { ok: true, zones } : all;
}
