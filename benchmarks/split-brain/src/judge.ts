import {
  type ClusterNode,
  type DivergenceGroup,
  type DivergenceKind,
  type DivergenceRoundResult,
  type OpenDivergence,
  TOPOLOGY_DIVERGENCE_MAX_MIGRATION_CHECKS,
  type TopologyDivergenceMonitor,
  type TrackedDisagreement,
  confirmedDisagreements,
  divergenceSeverity,
  groupDivergences,
  migrationTouchesSlots,
  outranksSeverity,
  settleOpenDivergences,
} from './product';

export interface JudgeOptions {
  minRounds: number;
  nodeTimeoutMs: number;
  membershipMinAgeMs: number;
  kinds?: ReadonlySet<DivergenceKind>;
}

export interface OwnerMigrations {
  self: ClusterNode | null;
  jobs: Record<string, string>[];
}

export type MigrationReader = (ownerId: string, seen: ClusterNode | null) => Promise<OwnerMigrations | null>;

export interface RaisedEvent {
  at: number;
  signature: string;
  severity: string;
  kinds: DivergenceKind[];
  dissent: string[];
  others: string[];
  replaces: boolean;
}

export interface JudgedRound {
  groups: DivergenceGroup[];
  raised: RaisedEvent[];
  closed: string[];
  open: string[];
}

export function parseSlotMigrationJobs(raw: unknown): Record<string, string>[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((job) => {
    const fields: Record<string, string> = {};
    if (Array.isArray(job)) {
      for (let i = 0; i + 1 < job.length; i += 2) fields[String(job[i])] = String(job[i + 1]);
    }
    return fields;
  });
}

export class Judge {
  private readonly open = new Map<string, OpenDivergence>();
  private readonly events = new Map<string, string>();
  private readonly settled = new Set<string>();

  constructor(
    private readonly monitor: Pick<TopologyDivergenceMonitor, 'restart'>,
    private readonly options: JudgeOptions,
  ) {}

  async observe(round: DivergenceRoundResult, readMigrations: MigrationReader): Promise<JudgedRound> {
    const { minRounds, kinds } = this.options;
    const disagreements = kinds ? round.disagreements.filter((d) => kinds.has(d.kind)) : round.disagreements;
    const comparable = round.status === 'ok';
    const countsFailures = disagreements.some((d) => d.kind === 'failure_flags');
    const rule = {
      minRounds,
      minAgeMs: {
        failure_flags: countsFailures ? this.options.nodeTimeoutMs : 0,
        membership: this.options.membershipMinAgeMs,
      },
    };
    const confirmed = comparable
      ? await this.withoutMigratingSlots(
          round,
          disagreements,
          confirmedDisagreements(disagreements, round.at, rule),
          readMigrations,
        )
      : [];
    const groups = groupDivergences(confirmed);
    const kept = settleOpenDivergences({
      open: this.open,
      openSignatures: [...this.events.keys()],
      confirmed: groups,
      pendingSignatures: new Set(groupDivergences(disagreements).map((group) => group.signature)),
      comparable,
      at: round.at,
      minRounds,
    });

    const replaced = new Set<string>();
    const closed: string[] = [];
    for (const group of groups) {
      const raised = this.events.get(group.signature);
      if (!raised || !outranksSeverity(divergenceSeverity(group), raised as never)) continue;
      this.events.delete(group.signature);
      replaced.add(group.signature);
    }

    const raised: RaisedEvent[] = [];
    const current = new Set(groups.map((group) => group.signature));
    for (const group of groups) {
      if (this.events.has(group.signature)) continue;
      const severity = divergenceSeverity(group);
      this.events.set(group.signature, severity);
      raised.push(this.eventOf(round.at, group, severity, replaced.has(group.signature)));
    }
    for (const signature of [...this.events.keys()]) {
      if (current.has(signature) || kept.has(signature)) continue;
      this.events.delete(signature);
      closed.push(signature);
    }

    for (const group of groups) {
      if (this.events.has(group.signature) && !this.open.get(group.signature)?.group) {
        this.open.set(group.signature, { group, lastCountedAt: round.at, clean: 0 });
      }
    }
    return { groups, raised, closed, open: [...this.events.keys()] };
  }

  private eventOf(at: number, group: DivergenceGroup, severity: string, replaces: boolean): RaisedEvent {
    return {
      at,
      signature: group.signature,
      severity,
      kinds: [...new Set(group.disagreements.map((d) => d.kind))].sort(),
      dissent: group.dissent,
      others: group.others,
      replaces,
    };
  }

  private async withoutMigratingSlots(
    round: DivergenceRoundResult,
    counted: TrackedDisagreement[],
    confirmed: TrackedDisagreement[],
    readMigrations: MigrationReader,
  ): Promise<TrackedDisagreement[]> {
    const keys = new Set(counted.map((d) => d.key));
    for (const key of [...this.settled]) {
      if (!keys.has(key)) this.settled.delete(key);
    }
    const unchecked = confirmed.filter((d) => d.kind === 'slot_owner' && !this.settled.has(d.key));
    if (unchecked.length === 0) return confirmed;

    const due = unchecked.slice(0, TOPOLOGY_DIVERGENCE_MAX_MIGRATION_CHECKS);
    const waiting = new Set(unchecked.slice(TOPOLOGY_DIVERGENCE_MAX_MIGRATION_CHECKS).map((d) => d.key));
    const ownerIds = [...new Set(due.flatMap((d) => d.subjectIds.slice(0, 2)))];
    const owners = new Map<string, OwnerMigrations>();
    for (const id of ownerIds) {
      const seen = round.selves.get(id) ?? null;
      const read = round.nodes.has(id) ? await readMigrations(id, seen) : null;
      owners.set(id, read ?? { self: seen, jobs: [] });
    }
    for (const dispute of due) {
      const migrating = dispute.subjectIds.slice(0, 2).some((id) => {
        const owner = owners.get(id);
        return owner ? migrationTouchesSlots(dispute.slots ?? [], owner.self, owner.jobs) : false;
      });
      if (!migrating) {
        this.settled.add(dispute.key);
        continue;
      }
      waiting.add(dispute.key);
      this.monitor.restart(round.clusterKey, dispute.key);
    }
    return confirmed.filter((d) => !waiting.has(d.key));
  }
}
