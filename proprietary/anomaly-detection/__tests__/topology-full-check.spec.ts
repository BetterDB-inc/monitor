import type { ClusterNode } from '@app/common/types/metrics.types';
import {
  FULL_CHECK_DEFAULTS,
  TopologyFullChecks,
  runFullCheck,
  type FullCheckOutcome,
  type FullCheckRun,
} from '../topology-full-check';

const AT = 1_000_000;
const SLOTS = 16384;

function node(id: string, patch: Partial<ClusterNode> = {}): ClusterNode {
  return {
    id,
    address: `${id}.internal:6379@16379`,
    flags: ['master'],
    master: '-',
    pingSent: 0,
    pongReceived: 0,
    configEpoch: 1,
    linkState: 'connected',
    slots: [],
    ...patch,
  };
}

function cluster(shards: number): ClusterNode[] {
  const width = Math.floor(SLOTS / shards);
  const nodes: ClusterNode[] = [];
  for (let shard = 0; shard < shards; shard++) {
    const shardId = `s${String(shard).padStart(3, '0')}`;
    const end = shard === shards - 1 ? SLOTS - 1 : (shard + 1) * width - 1;
    nodes.push(node(`${shardId}p`, { slots: [[shard * width, end]], shardId }));
    nodes.push(node(`${shardId}r`, { flags: ['slave'], master: `${shardId}p`, shardId }));
  }
  return nodes;
}

type Edit = (entry: ClusterNode, observerId: string) => ClusterNode;

function viewOf(nodes: ClusterNode[], observerId: string, edit: Edit = (entry) => entry): ClusterNode[] {
  return nodes.map((entry) => {
    const seen = edit(entry, observerId);
    return seen.id === observerId
      ? { ...seen, flags: ['myself', ...seen.flags], pingSent: 0, pongReceived: 0 }
      : { ...seen, pingSent: AT + seen.id.length, pongReceived: AT - 1 };
  });
}

function check(nodes: ClusterNode[], patch: Partial<FullCheckRun> = {}): Promise<FullCheckOutcome> {
  return runFullCheck({
    nodes,
    readView: async (asked) => viewOf(nodes, asked.id),
    now: () => AT,
    ...patch,
  });
}

function sides(outcome: FullCheckOutcome, key: string): Array<[string, string[]]> {
  const found = outcome.round.disagreements.find((entry) => entry.key === key);
  return (found?.positions ?? []).map((position) => [position.value, position.observers]);
}

describe('runFullCheck', () => {
  it('asks every node and finds nothing on a cluster whose views agree', async () => {
    const nodes = cluster(250);
    const asked: string[] = [];

    const outcome = await check(nodes, {
      readView: async (entry) => {
        asked.push(entry.id);
        return viewOf(nodes, entry.id);
      },
    });

    expect(asked.sort()).toEqual(nodes.map((entry) => entry.id).sort());
    expect(outcome).toMatchObject({ startedAt: AT, finishedAt: AT, total: 500, asked: 500, distinctViews: 1 });
    expect(outcome.round.status).toBe('ok');
    expect(outcome.round.observers).toHaveLength(500);
    expect(outcome.round.unanswered).toEqual([]);
    expect(outcome.round.disagreements).toEqual([]);
    expect(outcome.round.failureFlags.size).toBe(0);
  });

  it('counts every node on each side of a slot owner dispute', async () => {
    const nodes = cluster(250);
    const cutOff = new Set(['s001r', 's002p', 's004r']);
    const edit: Edit = (entry, observerId) => {
      if (!cutOff.has(observerId)) return entry;
      if (entry.id === 's000p') return { ...entry, slots: [[10, 64]] };
      if (entry.id === 's001p') return { ...entry, slots: [[0, 9], ...entry.slots] };
      return entry;
    };

    const outcome = await check(nodes, { readView: async (entry) => viewOf(nodes, entry.id, edit) });

    expect(outcome.distinctViews).toBe(2);
    const [first, second] = sides(outcome, 'slot_owner:s000p|s001p');
    expect([first[0], first[1].length]).toEqual(['s000p', 497]);
    expect(second).toEqual(['s001p', ['s001r', 's002p', 's004r']]);
    expect(outcome.round.disagreements[0].slots).toEqual([[0, 9]]);
  });

  it('leaves the opinion a node has of itself out of a failure count', async () => {
    const nodes = cluster(3);
    const accusers = new Set(['s001p', 's001r']);
    const edit: Edit = (entry, observerId) =>
      entry.id === 's002r' && accusers.has(observerId) ? { ...entry, flags: [...entry.flags, 'fail?'] } : entry;

    const outcome = await check(nodes, { readView: async (entry) => viewOf(nodes, entry.id, edit) });

    expect(outcome.distinctViews).toBe(2);
    expect(sides(outcome, 'failure_flags:s002r')).toEqual([
      ['failing', ['s001p', 's001r']],
      ['ok', ['s000p', 's000r', 's002p']],
    ]);
    expect(outcome.round.failureFlags.get('s002r')).toEqual({ suspected: ['s001p', 's001r'], failed: [] });
  });

  it('still counts the rest of a group when the accused node speaks for it', async () => {
    const nodes = cluster(3);
    const accusers = new Set(['s002p', 's002r']);
    const edit: Edit = (entry, observerId) =>
      entry.id === 's000p' && accusers.has(observerId) ? { ...entry, flags: [...entry.flags, 'fail'] } : entry;

    const outcome = await check(nodes, { readView: async (entry) => viewOf(nodes, entry.id, edit) });

    expect(sides(outcome, 'failure_flags:s000p')).toEqual([
      ['failing', ['s002p', 's002r']],
      ['ok', ['s000r', 's001p', 's001r']],
    ]);
    expect(outcome.round.failureFlags.get('s000p')).toEqual({ suspected: [], failed: ['s002p', 's002r'] });
  });

  it('finds no failure dispute when the only node that calls it fine is the node itself', async () => {
    const nodes = cluster(2);
    const edit: Edit = (entry, observerId) =>
      entry.id === 's000p' && observerId !== 's000p' ? { ...entry, flags: [...entry.flags, 'fail?'] } : entry;

    const outcome = await check(nodes, { readView: async (entry) => viewOf(nodes, entry.id, edit) });

    expect(outcome.distinctViews).toBe(2);
    expect(sides(outcome, 'failure_flags:s000p')).toEqual([]);
    expect(outcome.round.failureFlags.get('s000p')).toEqual({ suspected: ['s000r', 's001p', 's001r'], failed: [] });
  });

  it('counts the view a node has of its own epoch and membership', async () => {
    const nodes = cluster(2);
    const edit: Edit = (entry, observerId) =>
      entry.id === 's000p' && observerId === 's000p' ? { ...entry, configEpoch: 9 } : entry;

    const outcome = await check(nodes, { readView: async (entry) => viewOf(nodes, entry.id, edit) });

    expect(sides(outcome, 'config_epoch:s000p')).toEqual([
      ['1', ['s000r', 's001p', 's001r']],
      ['9', ['s000p']],
    ]);
  });

  it('counts a node that gives no view, a broken one or the view of another node as unanswered', async () => {
    const nodes = cluster(3);
    const outcome = await check(nodes, {
      readView: async (entry) => {
        if (entry.id === 's000r') return null;
        if (entry.id === 's001r') throw new Error('refused');
        if (entry.id === 's002r') return viewOf(nodes, 's002p');
        return viewOf(nodes, entry.id);
      },
    });

    expect(outcome.round.unanswered).toEqual(['s000r', 's001r', 's002r']);
    expect(outcome.round.observers).toHaveLength(6);
    expect(outcome.asked).toBe(6);
    expect(outcome.round.status).toBe('ok');
    expect(outcome.round.disagreements).toEqual([]);
  });

  it('gives up on a node that does not answer in time', async () => {
    const nodes = cluster(2);
    const outcome = await check(nodes, {
      readTimeoutMs: 20,
      readView: (entry) => (entry.id === 's001p' ? new Promise(() => undefined) : Promise.resolve(viewOf(nodes, entry.id))),
    });

    expect(outcome.round.unanswered).toEqual(['s001p']);
    expect(outcome.asked).toBe(4);
  });

  it('cannot compare when fewer than two nodes answer', async () => {
    const nodes = cluster(2);
    const outcome = await check(nodes, {
      readView: async (entry) => (entry.id === 's000p' ? viewOf(nodes, entry.id) : null),
    });

    expect(outcome.round.status).toBe('insufficient_views');
    expect(outcome.round.unanswered).toEqual(['s000r', 's001p', 's001r']);
    expect(outcome.round.disagreements).toEqual([]);
  });

  it('asks at most 16 nodes at a time and reports how far it is', async () => {
    const nodes = cluster(40);
    const progress: number[] = [];
    let inFlight = 0;
    let most = 0;

    const outcome = await check(nodes, {
      onProgress: (asked) => progress.push(asked),
      readView: async (entry) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
        return viewOf(nodes, entry.id);
      },
    });

    expect(FULL_CHECK_DEFAULTS.concurrency).toBe(16);
    expect(most).toBe(16);
    expect(progress).toEqual(Array.from({ length: 80 }, (_, at) => at + 1));
    expect(outcome.asked).toBe(80);
  });

  it('stops asking at the time limit and counts the rest as unanswered', async () => {
    const nodes = cluster(40);
    let clock = AT;
    const outcome = await check(nodes, {
      concurrency: 4,
      deadlineMs: 1000,
      now: () => clock,
      readView: async (entry) => {
        clock += 100;
        return viewOf(nodes, entry.id);
      },
    });

    expect(outcome.asked).toBeGreaterThanOrEqual(10);
    expect(outcome.asked).toBeLessThan(20);
    expect(outcome.round.observers).toHaveLength(80);
    expect(outcome.round.unanswered).toHaveLength(80 - outcome.asked);
    expect(outcome.finishedAt).toBeGreaterThanOrEqual(AT + 1000);
    expect(outcome.round.disagreements).toEqual([]);
  });

  it('keeps one copy of the views that say the same thing', async () => {
    const nodes = cluster(250);
    const epochOf = (observerId: string) => (observerId < 's100' ? 1 : observerId < 's200' ? 2 : 3);
    const edit: Edit = (entry, observerId) =>
      entry.id === 's249p' ? { ...entry, configEpoch: epochOf(observerId) } : entry;

    const outcome = await check(nodes, { readView: async (entry) => viewOf(nodes, entry.id, edit) });

    expect(outcome.distinctViews).toBe(3);
    expect(sides(outcome, 'config_epoch:s249p').map(([value, observers]) => [value, observers.length])).toEqual([
      ['1', 200],
      ['2', 200],
      ['3', 100],
    ]);
  });

  it('describes a node only some views list from what those views say', async () => {
    const nodes = cluster(2);
    const stray = node('zzzzp', { flags: ['master', 'fail?'], configEpoch: 4 });
    const outcome = await check(nodes, {
      readView: async (entry) =>
        entry.id === 's001r' ? [...viewOf(nodes, entry.id), stray] : viewOf(nodes, entry.id),
    });

    expect(sides(outcome, 'membership:zzzzp')).toEqual([
      ['known', ['s001r']],
      ['missing', ['s000p', 's000r', 's001p']],
    ]);
    expect(outcome.round.nodes.get('zzzzp')).toMatchObject({ id: 'zzzzp', address: 'zzzzp.internal:6379@16379' });
    expect(outcome.round.nodes.get('s000p')?.shardId).toBe('s000');
  });

  it('gets through 500 nodes that all say something different within the time budget', async () => {
    const nodes = cluster(250);
    const edit: Edit = (entry, observerId) => (entry.id === observerId ? { ...entry, configEpoch: 7 } : entry);
    await check(cluster(3));

    const startedAt = performance.now();
    const outcome = await check(nodes, { readView: async (entry) => viewOf(nodes, entry.id, edit) });
    const elapsed = performance.now() - startedAt;

    expect(outcome.distinctViews).toBe(500);
    expect(outcome.round.disagreements).toHaveLength(500);
    expect(sides(outcome, 'config_epoch:s000p').map(([value, observers]) => [value, observers.length])).toEqual([
      ['1', 499],
      ['7', 1],
    ]);
    expect(elapsed).toBeLessThan(5000);
  });
});

describe('TopologyFullChecks', () => {
  function deferred() {
    let finish: (outcome: FullCheckOutcome) => void = () => undefined;
    let fail: (error: Error) => void = () => undefined;
    const promise = new Promise<FullCheckOutcome>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    return { promise, finish, fail };
  }

  function settled(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }

  async function outcomeAt(finishedAt: number): Promise<FullCheckOutcome> {
    const outcome = await check(cluster(2));
    return { ...outcome, finishedAt };
  }

  it('has nothing for a cluster that was never checked', () => {
    expect(new TopologyFullChecks().state('c1', AT)).toEqual({ state: 'none' });
  });

  it('runs a check, shows how far it is and keeps the result', async () => {
    const checks = new TopologyFullChecks();
    const run = deferred();

    const started = checks.start('c1', AT, 4, (onProgress) => {
      onProgress(3);
      return run.promise;
    });

    expect(started).toEqual({ result: 'started' });
    expect(checks.state('c1', AT + 100)).toEqual({ state: 'running', startedAt: AT, asked: 3, total: 4 });

    const outcome = await outcomeAt(AT + 500);
    run.finish(outcome);
    await settled();

    expect(checks.state('c1', AT + 600)).toEqual({
      state: 'done',
      startedAt: AT,
      finishedAt: AT + 500,
      asked: 4,
      total: 4,
      outcome,
    });
  });

  it('joins the running check instead of starting a second one', () => {
    const checks = new TopologyFullChecks();
    const runs = jest.fn(() => deferred().promise);

    checks.start('c1', AT, 4, runs);
    const second = checks.start('c1', AT + 10, 4, runs);

    expect(second).toEqual({ result: 'running' });
    expect(runs).toHaveBeenCalledTimes(1);
  });

  it('refuses a new check within 30 seconds of the last one and says when to retry', async () => {
    const checks = new TopologyFullChecks();
    const outcome = await outcomeAt(AT + 500);
    checks.start('c1', AT, 4, () => Promise.resolve(outcome));
    await settled();
    const runs = jest.fn(() => Promise.resolve(outcome));

    expect(FULL_CHECK_DEFAULTS.minIntervalMs).toBe(30_000);
    expect(checks.start('c1', AT + 30_499, 4, runs)).toEqual({ result: 'too_soon', retryAt: AT + 30_500 });
    expect(runs).not.toHaveBeenCalled();
    expect(checks.start('c1', AT + 30_500, 4, runs)).toEqual({ result: 'started' });
  });

  it('drops a result after 10 minutes', async () => {
    const checks = new TopologyFullChecks();
    const outcome = await outcomeAt(AT + 500);
    checks.start('c1', AT, 4, () => Promise.resolve(outcome));
    await settled();

    expect(FULL_CHECK_DEFAULTS.keepMs).toBe(600_000);
    expect(checks.state('c1', AT + 500 + 599_999).state).toBe('done');
    expect(checks.state('c1', AT + 500 + 600_000)).toEqual({ state: 'none' });
  });

  it('keeps the checks of two clusters apart', () => {
    const checks = new TopologyFullChecks();
    checks.start('c1', AT, 4, () => deferred().promise);

    expect(checks.state('c2', AT)).toEqual({ state: 'none' });
    expect(checks.start('c2', AT, 6, () => deferred().promise)).toEqual({ result: 'started' });
  });

  it('forgets a cluster and ignores a check of it that ends later', async () => {
    const checks = new TopologyFullChecks();
    const run = deferred();
    checks.start('c1', AT, 4, () => run.promise);

    checks.forget('c1');
    run.finish(await outcomeAt(AT + 500));
    await settled();

    expect(checks.state('c1', AT + 600)).toEqual({ state: 'none' });
  });

  it('goes back to nothing when a check breaks, and lets the next one start', async () => {
    const checks = new TopologyFullChecks();
    const run = deferred();
    checks.start('c1', AT, 4, () => run.promise);

    run.fail(new Error('boom'));
    await settled();

    expect(checks.state('c1', AT + 10)).toEqual({ state: 'none' });
    expect(checks.start('c1', AT + 20, 4, () => deferred().promise)).toEqual({ result: 'started' });
  });
});
