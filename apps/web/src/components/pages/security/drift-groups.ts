import type { Advisory, CveFinding, ScannedNode } from '@betterdb/shared';

export interface NodeGroups {
  unique: CveFinding[];
  shared: CveFinding[];
  unversioned: Advisory[];
  badge: number;
}

export function groupFindings(nodes: ScannedNode[]): Map<string, NodeGroups> {
  const presence = new Map<string, number>();

  for (const entry of nodes) {
    for (const item of entry.findings) {
      presence.set(item.advisory.cveId, (presence.get(item.advisory.cveId) ?? 0) + 1);
    }
  }

  const grouped = new Map<string, NodeGroups>();

  for (const entry of nodes) {
    const shared: CveFinding[] = [];
    const unique: CveFinding[] = [];

    for (const item of entry.findings) {
      if (presence.get(item.advisory.cveId) === nodes.length) {
        shared.push(item);
        continue;
      }

      unique.push(item);
    }

    grouped.set(entry.nodeId, {
      unique,
      shared,
      unversioned: entry.unversioned,
      badge: unique.length + shared.length,
    });
  }

  return grouped;
}
