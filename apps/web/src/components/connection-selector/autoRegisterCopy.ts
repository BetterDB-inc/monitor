import type { Connection } from '../../hooks/useConnection';

function autoMembers(seedId: string, all: Connection[]): Connection[] {
  return all.filter((c) => c.membership?.seedId === seedId && c.membership.origin === 'auto');
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

export function deleteConfirmation(target: Connection, all: Connection[]): string {
  if (target.membership?.origin === 'auto') {
    const seed = all.find((c) => c.id === target.membership!.seedId);
    return `Delete ${target.name}? It will be registered again on the next sync unless auto-registration is turned off on ${seed?.name ?? 'its seed'}.`;
  }
  const autos = target.membership ? [] : autoMembers(target.id, all);
  if (autos.length > 0) {
    return `Delete ${target.name}? This also deletes ${plural(autos.length, 'auto-registered node')}; adopted connections are kept.`;
  }
  return 'Are you sure you want to delete this connection?';
}

export function disableConfirmation(seed: Connection, all: Connection[]): string {
  const active = autoMembers(seed.id, all).filter((c) => c.membership?.retiredAt === undefined);
  const noun = plural(active.length, 'auto-registered node');
  return `${noun} will be retired. ${active.length === 1 ? 'Its' : 'Their'} history is kept.`;
}

export function showsAutoRegisterToggle(connection: Connection): boolean {
  return (
    !connection.membership &&
    connection.connectionType !== 'external' &&
    connection.connectionType !== 'agent' &&
    (connection.capabilities?.clusterEnabled === true || connection.capabilities?.isSentinel === true)
  );
}

export function autoRegisterDefaultFor(
  connection: Pick<Connection, 'capabilities'>,
  defaults: { cluster: boolean; sentinel: boolean },
): boolean {
  return connection.capabilities?.isSentinel === true ? defaults.sentinel : defaults.cluster;
}

export function groupSentinelMembers(
  seedId: string,
  all: Connection[],
): Array<{ group: string; members: Connection[] }> {
  const groups = new Map<string, Connection[]>();
  for (const c of all) {
    if (c.membership?.seedId !== seedId || c.membership.source !== 'sentinel') continue;
    const key = c.membership.group ?? '';
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, members]) => ({
      group,
      members: [...members].sort(
        (x, y) => Number(y.membership?.role === 'primary') - Number(x.membership?.role === 'primary'),
      ),
    }));
}
