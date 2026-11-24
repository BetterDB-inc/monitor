import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { ConnectionRegistry } from '../connections/connection-registry.service';

export interface FailoverSignature {
  readonly key: string;
  readonly holdMs: number;
  readonly releases?: string;
  readonly epoch?: number;
  readonly renewsOnLaterEpoch?: boolean;
}

interface HeldClaim {
  readonly heldUntil: number;
  readonly epoch?: number;
}

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

export function followerSignature(primaryId: string, configEpoch: number): FailoverSignature {
  return { key: `primary:${primaryId}`, holdMs: PROMOTION_HOLD_MS, epoch: configEpoch };
}

export function promotionSignature(primaryId: string, configEpoch: number): FailoverSignature {
  return { ...followerSignature(primaryId, configEpoch), renewsOnLaterEpoch: true };
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

  observe(connectionId: string, nodes: ReadonlyArray<{ id?: string }>): void {
    const nodeIds = new Set(nodes.map((node) => node.id).filter((id): id is string => !!id));
    if (nodeIds.size === 0) return;
    const known = [...nodeIds].map((id) => this.keyByNode.get(id)).find(Boolean);
    const clusterKey = known ?? `cluster:${randomUUID()}`;
    const previous = this.views.get(connectionId);
    this.views.set(connectionId, nodeIds);
    this.keyByConnection.set(connectionId, clusterKey);
    nodeIds.forEach((id) => this.keyByNode.set(id, clusterKey));
    if (previous) this.releaseNodes(previous);
  }

  forget(connectionId: string): void {
    const view = this.views.get(connectionId);
    this.views.delete(connectionId);
    this.keyByConnection.delete(connectionId);
    if (view) this.releaseNodes(view);
  }

  clusterKeyOf(connectionId: string): string {
    return (
      this.keyByConnection.get(connectionId) ??
      this.connectionRegistry.getConfig(connectionId)?.membership?.seedId ??
      connectionId
    );
  }

  claimFailover(clusterKey: string, signature: FailoverSignature, now: number): boolean {
    for (const [claim, held] of this.claims) {
      if (held.heldUntil <= now) this.claims.delete(claim);
    }
    const claim = `${clusterKey}|${signature.key}`;
    const held = this.claims.get(claim);
    const renewed =
      signature.renewsOnLaterEpoch === true && (signature.epoch ?? 0) > (held?.epoch ?? 0);
    if (held && !renewed) return false;
    this.claims.set(claim, { heldUntil: now + signature.holdMs, epoch: signature.epoch });
    if (signature.releases) this.claims.delete(`${clusterKey}|${signature.releases}`);
    return true;
  }

  eventConnectionOf(connectionId: string): string {
    const membership = this.connectionRegistry.getConfig(connectionId)?.membership;
    if (membership?.origin !== 'auto') return connectionId;
    return this.isConnected(membership.seedId) ? membership.seedId : connectionId;
  }

  private isConnected(connectionId: string): boolean {
    try {
      return this.connectionRegistry.get(connectionId).isConnected();
    } catch {
      return false;
    }
  }

  private releaseNodes(nodeIds: ReadonlySet<string>): void {
    const views = [...this.views.values()];
    for (const nodeId of nodeIds) {
      if (!views.some((view) => view.has(nodeId))) this.keyByNode.delete(nodeId);
    }
  }
}
