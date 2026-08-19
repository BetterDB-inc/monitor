import type { Connection } from '../../../hooks/useConnection';

export type PreflightTone = 'ok' | 'info' | 'warning';

export type DirectionKind =
  | 'engine-change'
  | 'engine-downgrade'
  | 'version-upgrade'
  | 'version-downgrade'
  | 'identical';

export interface MigrationDirection {
  label: string;
  kind: DirectionKind;
}

export interface PreflightNote {
  id: string;
  tone: PreflightTone;
  message: string;
}

const AGENT_BLOCK_MESSAGE =
  'One or more selected instances is connected via an agent. Contact support@betterdb.com and we will help you plan the migration safely.';

function engineName(dbType: 'valkey' | 'redis'): string {
  if (dbType === 'valkey') {
    return 'Valkey';
  }
  return 'Redis';
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.');
  const rightParts = right.split('.');
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index++) {
    const leftValue = Number.parseInt(leftParts[index] ?? '0', 10);
    const rightValue = Number.parseInt(rightParts[index] ?? '0', 10);
    const leftSegment = Number.isNaN(leftValue) ? 0 : leftValue;
    const rightSegment = Number.isNaN(rightValue) ? 0 : rightValue;

    if (leftSegment !== rightSegment) {
      return leftSegment < rightSegment ? -1 : 1;
    }
  }

  return 0;
}

function directionKind(
  source: NonNullable<Connection['capabilities']>,
  target: NonNullable<Connection['capabilities']>,
): DirectionKind {
  const comparison = compareVersions(source.version, target.version);

  // Versions across engines are not strictly comparable — Valkey forked at Redis
  // 7.2, so the numbers share a lineage but not a release history, and the backend
  // compatibility report has the real say. A cross-engine move to a LOWER version
  // is still the riskier direction, so it is called out rather than getting the
  // neutral engine-change note by accident of branch order.
  if (source.dbType !== target.dbType) {
    return comparison > 0 ? 'engine-downgrade' : 'engine-change';
  }

  if (comparison < 0) {
    return 'version-upgrade';
  }
  if (comparison > 0) {
    return 'version-downgrade';
  }
  return 'identical';
}

export function describeDirection(
  source: Connection | null,
  target: Connection | null,
): MigrationDirection | null {
  if (source === null || target === null) {
    return null;
  }

  const sourceCapabilities = source.capabilities;
  const targetCapabilities = target.capabilities;
  if (sourceCapabilities === undefined || targetCapabilities === undefined) {
    return null;
  }

  const from = `${engineName(sourceCapabilities.dbType)} ${sourceCapabilities.version}`;
  const to = `${engineName(targetCapabilities.dbType)} ${targetCapabilities.version}`;

  return {
    label: `${from} → ${to}`,
    kind: directionKind(sourceCapabilities, targetCapabilities),
  };
}

export function isPlanComplete(source: Connection | null, target: Connection | null): boolean {
  return source !== null && target !== null;
}

export function planBlock(source: Connection | null, target: Connection | null): string | null {
  if (isPlanComplete(source, target) === false) {
    return null;
  }

  const from = source as Connection;
  const to = target as Connection;

  if (from.id === to.id) {
    return 'Source and target must be different connections.';
  }

  if (from.connectionType === 'agent' || to.connectionType === 'agent') {
    return AGENT_BLOCK_MESSAGE;
  }

  return null;
}

function directionNote(direction: MigrationDirection): PreflightNote {
  if (direction.kind === 'version-downgrade') {
    return {
      id: 'direction',
      tone: 'warning',
      message: `${direction.label} — the target runs an older version and may not accept everything the source stores.`,
    };
  }

  if (direction.kind === 'engine-downgrade') {
    return {
      id: 'direction',
      tone: 'warning',
      message: `${direction.label} — engine change to an older version. The target may not accept everything the source stores, and analysis will report anything it handles differently.`,
    };
  }

  if (direction.kind === 'engine-change') {
    return {
      id: 'direction',
      tone: 'info',
      message: `${direction.label} — engine change. Analysis will report anything the target handles differently.`,
    };
  }

  if (direction.kind === 'version-upgrade') {
    return { id: 'direction', tone: 'info', message: `${direction.label} — version upgrade.` };
  }

  return {
    id: 'direction',
    tone: 'info',
    message: `${direction.label} — matching engine and version.`,
  };
}

export function preflightNotes(
  source: Connection | null,
  target: Connection | null,
): PreflightNote[] {
  if (isPlanComplete(source, target) === false) {
    return [];
  }

  const from = source as Connection;
  const to = target as Connection;
  const notes: PreflightNote[] = [];

  if (from.isConnected === true && to.isConnected === true) {
    notes.push({
      id: 'reachability',
      tone: 'ok',
      message: 'Both endpoints responded on their last health check.',
    });
  }

  if (from.isConnected === false) {
    notes.push({
      id: 'source-offline',
      tone: 'warning',
      message: `${from.name} appears to be offline and may refuse the connection.`,
    });
  }

  if (to.isConnected === false) {
    notes.push({
      id: 'target-offline',
      tone: 'warning',
      message: `${to.name} appears to be offline and may refuse the connection.`,
    });
  }

  const direction = describeDirection(from, to);
  if (direction !== null) {
    notes.push(directionNote(direction));
  }

  notes.push({
    id: 'read-only',
    tone: 'info',
    message: 'Analysis samples keys with SCAN. Neither instance is modified at this step.',
  });

  return notes;
}
