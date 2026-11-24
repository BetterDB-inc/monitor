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
  ): void {
    const nodeIds = new Set(
      nodes
        .filter((node) => !node.flags?.some((flag) => NOT_LIVE_FLAGS.includes(flag)))
        .map((node) => node.id)
        .filter((id): id is string => !!id),
    );
    if (nodeIds.size === 0) return;
    if (nodes.length === 1) {
      this.standAlone(connectionId, [...nodeIds][0]);
      return;
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
    const clusterKey = this.clusterKeyOf(connectionId);
    const filedUnder = this.eventConnectionOf(connectionId);
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
    return registered
      .filter(
        ({ id, membership }) =>
          id !== filedUnder &&
          !readsAnotherCluster(id) &&
          (anchors.has(id) || (membership !== undefined && anchors.has(membership.seedId))),
      )
      .map(({ id, host, port }) => ({ connectionId: id, instance: { host, port } }));
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
