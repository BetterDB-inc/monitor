import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ConnectionRegistry } from '../connections/connection-registry.service';

export interface FailoverSignature {
  readonly key: string;
  readonly holdMs: number;
  readonly releases?: string;
  readonly epoch?: number;
  readonly renewsOnLaterEpoch?: boolean;
  readonly sightingOnly?: boolean;
}

export interface ScopedConnection {
  readonly connectionId: string;
  readonly instance: { host: string; port: number };
}

interface ClusterReader {
  readonly connectionId: string;
  readonly readAt: number;
  readonly dials: boolean;
}

interface ReadTurns {
  readonly polledAt: number;
  readonly poll: number;
  readonly last?: string;
  readonly passPolls: number;
  readonly granted: Map<string, number>;
  readonly urgent: Set<string>;
}

interface HeldClaim {
  readonly claimedAt: number;
  readonly heldUntil: number;
  readonly epoch?: number;
  readonly releaseTimes: readonly number[];
  readonly sightingOnly?: boolean;
}

const NOT_LIVE_FLAGS = ['handshake', 'noaddr', 'fail', 'fail?'];
const STATE_HOLD_MS = 60_000;
const PROMOTION_HOLD_MS = 10 * 60_000;
const READER_GRACE_MS = 60_000;
const READER_POLL_GRACE_MS = 15_000;
const MEMBER_READS_PER_POLL = 8;
const URGENT_READS_PER_POLL = 4;

const OUTAGE = 'outage';
const RECOVERY = 'recovery';

export function outageSignature(): FailoverSignature {
  return { key: OUTAGE, holdMs: STATE_HOLD_MS, releases: RECOVERY };
}

export function clusterStateSignature(state: string): FailoverSignature {
  if (state === 'fail') return outageSignature();
  return { key: RECOVERY, holdMs: STATE_HOLD_MS, releases: OUTAGE };
}

export function recoverySightingSignature(): FailoverSignature {
  return { ...clusterStateSignature('ok'), sightingOnly: true };
}

export function followerSignature(primaryId: string, configEpoch: number): FailoverSignature {
  return { key: `primary:${primaryId}`, holdMs: PROMOTION_HOLD_MS, epoch: configEpoch };
}

export function promotionSignature(primaryId: string, configEpoch: number): FailoverSignature {
  return { ...followerSignature(primaryId, configEpoch), renewsOnLaterEpoch: true };
}

function claimOfBoth(kept: HeldClaim, joined: HeldClaim): HeldClaim {
  const claimedAt = Math.max(kept.claimedAt, joined.claimedAt);
  const epochs = [kept.epoch, joined.epoch].filter((epoch): epoch is number => epoch !== undefined);
  return {
    claimedAt,
    heldUntil: Math.max(kept.heldUntil, joined.heldUntil),
    epoch: epochs.length > 0 ? Math.max(...epochs) : undefined,
    releaseTimes: [...kept.releaseTimes, ...joined.releaseTimes].filter(
      (releasedAt) => releasedAt >= claimedAt,
    ),
    sightingOnly: kept.sightingOnly && joined.sightingOnly,
  };
}

@Injectable()
export class ClusterIdentityService implements OnModuleInit, OnModuleDestroy {
  private readonly views = new Map<string, ReadonlySet<string>>();
  private readonly keyByConnection = new Map<string, string>();
  private readonly keyByNode = new Map<string, string>();
  private readonly claims = new Map<string, HeldClaim>();
  private readonly readers = new Map<string, ClusterReader>();
  private readonly readTurns = new Map<string, ReadTurns>();
  private stopListening: (() => void) | undefined;

  constructor(private readonly connectionRegistry: ConnectionRegistry) {}

  onModuleInit(): void {
    this.stopListening = this.connectionRegistry.addConnectionRemovalListener((connectionId) =>
      this.forget(connectionId),
    );
  }

  onModuleDestroy(): void {
    this.stopListening?.();
    this.stopListening = undefined;
  }

  observe(
    connectionId: string,
    nodes: ReadonlyArray<{ id?: string; flags?: ReadonlyArray<string> }>,
  ): string[] {
    const nodeIds = new Set(
      nodes
        .filter((node) => !node.flags?.some((flag) => NOT_LIVE_FLAGS.includes(flag)))
        .map((node) => node.id)
        .filter((id): id is string => !!id),
    );
    if (nodeIds.size === 0) return [];
    if (nodes.length === 1) {
      this.standAlone(connectionId, [...nodeIds][0]);
      return [];
    }
    const [known, ...joined] = [
      ...new Set(
        [...nodeIds].map((id) => this.keyByNode.get(id)).filter((key): key is string => !!key),
      ),
    ].sort();
    const clusterKey = known ?? `cluster:${randomUUID()}`;
    joined.forEach((key) => this.join(key, clusterKey));
    const previous = this.views.get(connectionId);
    this.views.set(connectionId, nodeIds);
    this.keyByConnection.set(connectionId, clusterKey);
    nodeIds.forEach((id) => this.keyByNode.set(id, clusterKey));
    if (previous) this.releaseNodes(previous);
    return joined;
  }

  private standAlone(connectionId: string, nodeId: string): void {
    const previous = this.views.get(connectionId);
    this.views.delete(connectionId);
    this.keyByConnection.set(connectionId, `node:${nodeId}`);
    if (previous) this.releaseNodes(previous);
  }

  forget(connectionId: string): void {
    const view = this.views.get(connectionId);
    this.views.delete(connectionId);
    this.keyByConnection.delete(connectionId);
    if (view) this.releaseNodes(view);
    for (const [clusterKey, reader] of this.readers) {
      if (reader.connectionId === connectionId) this.readers.delete(clusterKey);
    }
  }

  clusterKeyOf(connectionId: string): string {
    return this.observedKeyOf(connectionId) ?? this.seedIdOf(connectionId) ?? connectionId;
  }

  claimFailover(
    clusterKey: string,
    signature: FailoverSignature,
    now: number,
    stateChangedAt?: number,
  ): boolean {
    for (const [claim, held] of this.claims) {
      if (held.heldUntil <= now) this.claims.delete(claim);
    }
    const claim = `${clusterKey}|${signature.key}`;
    const held = this.claims.get(claim);
    const renewed =
      signature.renewsOnLaterEpoch === true && (signature.epoch ?? 0) > (held?.epoch ?? 0);
    const released =
      held !== undefined &&
      stateChangedAt !== undefined &&
      held.releaseTimes.some((releasedAt) => stateChangedAt >= releasedAt);
    const reportsSighting =
      held?.sightingOnly === true &&
      signature.sightingOnly !== true &&
      held.releaseTimes.length === 0;
    if (held && !renewed && !released && !reportsSighting) return false;
    this.claims.set(claim, {
      claimedAt: reportsSighting ? held.claimedAt : now,
      heldUntil: now + signature.holdMs,
      epoch: signature.epoch,
      releaseTimes: [],
      sightingOnly: signature.sightingOnly,
    });
    if (signature.releases && !reportsSighting) {
      this.release(`${clusterKey}|${signature.releases}`, now);
    }
    return true;
  }

  claimReader(connectionId: string, now: number, dials = true): boolean {
    const clusterKey = this.clusterKeyOf(connectionId);
    const reader = this.readers.get(clusterKey);
    const claim: ClusterReader = { connectionId, readAt: now, dials };
    const heldByAnother =
      reader !== undefined &&
      reader.connectionId !== connectionId &&
      this.stillReads(reader, clusterKey, now);
    if (heldByAnother && !this.goesBefore(claim, reader)) return false;
    this.readers.set(clusterKey, claim);
    return !heldByAnother;
  }

  takeTopologyRead(connectionId: string, schedule: string, now: number, urgent = false): boolean {
    const clusterKey = this.clusterKeyOf(connectionId);
    const reader = this.readers.get(clusterKey);
    if (!reader || !this.stillReads(reader, clusterKey, now)) return true;
    const turnsKey = `${clusterKey}|${schedule}`;
    if (reader.connectionId === connectionId) {
      this.readTurns.set(turnsKey, this.nextTurns(this.readTurns.get(turnsKey), connectionId, now));
      return true;
    }
    const turns = this.readTurns.get(turnsKey);
    if (!turns || now - turns.polledAt > READER_POLL_GRACE_MS || turns.passPolls === 1) return true;
    if (urgent) turns.urgent.add(connectionId);
    else turns.urgent.delete(connectionId);
    return turns.granted.delete(connectionId);
  }

  topologyReadPolls(connectionId: string, schedule: string): number {
    const clusterKey = this.clusterKeyOf(connectionId);
    if (this.readers.get(clusterKey)?.connectionId === connectionId) return 1;
    return this.readTurns.get(`${clusterKey}|${schedule}`)?.passPolls ?? 1;
  }

  isReader(connectionId: string): boolean {
    return this.readers.get(this.clusterKeyOf(connectionId))?.connectionId === connectionId;
  }

  clusterConnectionIds(connectionId: string): string[] {
    return this.clusterConnections(connectionId).map(({ id }) => id);
  }

  eventConnectionOf(connectionId: string): string {
    const membership = this.connectionRegistry.getConfig(connectionId)?.membership;
    if (membership?.origin !== 'auto') return connectionId;
    if (!this.connectionRegistry.getConfig(membership.seedId)) return connectionId;
    const ownKey = this.keyByConnection.get(connectionId);
    const seedKey = this.keyByConnection.get(membership.seedId);
    const readsAnotherCluster = ownKey !== undefined && seedKey !== undefined && ownKey !== seedKey;
    return readsAnotherCluster ? connectionId : membership.seedId;
  }

  otherClusterConnections(connectionId: string): ScopedConnection[] {
    const filedUnder = this.eventConnectionOf(connectionId);
    return this.clusterConnections(connectionId)
      .filter(({ id }) => id !== filedUnder)
      .map(({ id, host, port }) => ({ connectionId: id, instance: { host, port } }));
  }

  private clusterConnections(connectionId: string): ReturnType<ConnectionRegistry['list']> {
    const clusterKey = this.clusterKeyOf(connectionId);
    const registered = this.connectionRegistry.list();
    const observedKey = this.observedKeyOf(connectionId);
    const readsAnotherCluster = (id: string): boolean => {
      const key = this.observedKeyOf(id);
      return observedKey !== undefined && key !== undefined && key !== observedKey;
    };
    const anchors = new Set(
      registered
        .filter((connection) => this.clusterKeyOf(connection.id) === clusterKey)
        .flatMap(({ id, membership }) => (membership ? [id, membership.seedId] : [id])),
    );
    return registered.filter(
      ({ id, membership }) =>
        !readsAnotherCluster(id) &&
        (anchors.has(id) || (membership !== undefined && anchors.has(membership.seedId))),
    );
  }

  private nextTurns(held: ReadTurns | undefined, readerId: string, now: number): ReadTurns {
    const poll = (held?.poll ?? 0) + 1;
    const others = this.clusterConnectionIds(readerId)
      .filter((id) => id !== readerId)
      .sort();
    if (others.length <= MEMBER_READS_PER_POLL) {
      return { polledAt: now, poll, passPolls: 1, granted: new Map(), urgent: new Set() };
    }
    const urgent = others.filter((id) => held?.urgent.has(id));
    const first = urgent.slice(0, URGENT_READS_PER_POLL);
    const rotating = others.filter((id) => !first.includes(id));
    const slots = MEMBER_READS_PER_POLL - first.length;
    const last = held?.last;
    const next = last === undefined ? 0 : rotating.findIndex((id) => id > last);
    const start = Math.max(next, 0);
    const turn = Array.from({ length: slots }, (_, i) => rotating[(start + i) % rotating.length]);
    const granted = new Map(
      [...(held?.granted ?? [])].filter(([, grantedAt]) => grantedAt === poll - 1),
    );
    [...first, ...turn].forEach((id) => granted.set(id, poll));
    return {
      polledAt: now,
      poll,
      last: turn[turn.length - 1],
      passPolls: Math.ceil(rotating.length / slots),
      granted,
      urgent: new Set(urgent),
    };
  }

  private stillReads(reader: ClusterReader, clusterKey: string, now: number): boolean {
    return (
      now - reader.readAt <= READER_GRACE_MS &&
      this.connectionRegistry.getConfig(reader.connectionId) !== null &&
      this.clusterKeyOf(reader.connectionId) === clusterKey
    );
  }

  private goesBefore(reader: ClusterReader, other: ClusterReader): boolean {
    if (reader.dials !== other.dials) return reader.dials;
    const rank = (id: string): number =>
      this.connectionRegistry.getConfig(id)?.membership?.origin === 'auto' ? 1 : 0;
    const [own, others] = [rank(reader.connectionId), rank(other.connectionId)];
    return own !== others ? own < others : reader.connectionId < other.connectionId;
  }

  private observedKeyOf(connectionId: string): string | undefined {
    const ownKey = this.keyByConnection.get(connectionId);
    if (ownKey !== undefined) return ownKey;
    const seedId = this.seedIdOf(connectionId);
    return seedId === undefined ? undefined : this.keyByConnection.get(seedId);
  }

  private seedIdOf(connectionId: string): string | undefined {
    return this.connectionRegistry.getConfig(connectionId)?.membership?.seedId;
  }

  private join(joinedKey: string, clusterKey: string): void {
    for (const [nodeId, key] of this.keyByNode) {
      if (key === joinedKey) this.keyByNode.set(nodeId, clusterKey);
    }
    for (const [connectionId, key] of this.keyByConnection) {
      if (key === joinedKey) this.keyByConnection.set(connectionId, clusterKey);
    }
    const prefix = `${joinedKey}|`;
    for (const [claim, held] of [...this.claims]) {
      if (!claim.startsWith(prefix)) continue;
      const moved = `${clusterKey}|${claim.slice(prefix.length)}`;
      const kept = this.claims.get(moved);
      this.claims.delete(claim);
      this.claims.set(moved, kept ? claimOfBoth(kept, held) : held);
    }
    const joinedReader = this.readers.get(joinedKey);
    const keptReader = this.readers.get(clusterKey);
    this.readers.delete(joinedKey);
    if (!joinedReader) return;
    if (!keptReader || this.goesBefore(joinedReader, keptReader)) {
      this.readers.set(clusterKey, joinedReader);
    }
  }

  private release(claim: string, now: number): void {
    const held = this.claims.get(claim);
    if (held) this.claims.set(claim, { ...held, releaseTimes: [...held.releaseTimes, now] });
  }

  private releaseNodes(nodeIds: ReadonlySet<string>): void {
    const views = [...this.views.values()];
    for (const nodeId of nodeIds) {
      if (!views.some((view) => view.has(nodeId))) this.keyByNode.delete(nodeId);
    }
  }
}
