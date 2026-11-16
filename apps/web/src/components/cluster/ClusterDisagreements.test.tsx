import { describe, it, expect } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ClusterDisagreements } from './ClusterDisagreements';
import type {
  DisagreementLine,
  DisagreementShard,
  DivergenceNode,
  TopologyDisagreementSummary,
} from '@/types/anomaly';

const AT = 1_704_067_200_000;

function node(nodeId: string, patch: Partial<DivergenceNode> = {}): DivergenceNode {
  return {
    nodeId,
    address: `${nodeId}.internal:6379`,
    role: nodeId.endsWith('p') ? 'primary' : 'replica',
    ...patch,
  };
}

function shardName(index: number): string {
  return `s${String(index).padStart(3, '0')}`;
}

function shard(index: number, patch: Partial<DisagreementShard> = {}): DisagreementShard {
  const shardId = shardName(index);
  return {
    shardId,
    primary: node(`${shardId}p`),
    replicas: 1,
    zones: ['a', 'b'],
    slots: [[index * 65, index * 65 + 64]],
    slotCount: 65,
    nodes: 2,
    ownViews: 0,
    state: 'undisputed',
    disagreementIds: [],
    ...patch,
  };
}

function slotLine(patch: Partial<DisagreementLine> = {}): DisagreementLine {
  return {
    id: 'slot_owner:s000p|s001p',
    kind: 'slot_owner',
    severity: 'critical',
    confirmed: true,
    eventId: 'event-1',
    eventType: 'topology_divergence',
    since: AT - 30_000,
    rounds: 6,
    stale: false,
    lastSeenAt: AT,
    subjects: [node('s000p'), node('s001p')],
    subjectCount: 2,
    slots: [[0, 9]],
    slotCount: 10,
    shardIds: ['s000', 's001'],
    positions: [
      {
        value: 's000p',
        owner: node('s000p'),
        count: 9,
        observers: [node('s000p'), node('s000r'), node('s003p')],
      },
      {
        value: 's001p',
        owner: node('s001p'),
        count: 3,
        observers: [node('s001p'), node('s001r'), node('s002p')],
      },
    ],
    text: 'Slots 0-9: owned by s000p.internal:6379 in 9 views, by s001p.internal:6379 in 3 views.',
    ...patch,
  };
}

function flagsLine(patch: Partial<DisagreementLine> = {}): DisagreementLine {
  return {
    id: 'failure_flags:s002r',
    kind: 'failure_flags',
    severity: 'warning',
    confirmed: false,
    eventId: null,
    eventType: null,
    since: AT - 10_000,
    rounds: 2,
    stale: false,
    lastSeenAt: AT,
    subjects: [node('s002r')],
    subjectCount: 1,
    shardIds: ['s002'],
    positions: [
      { value: 'ok', count: 8, observers: [node('s000p')] },
      { value: 'fail?', count: 3, observers: [node('s001p'), node('s001r'), node('s002p')] },
      { value: 'fail', count: 1, observers: [node('s003p')] },
    ],
    text: 's002r.internal:6379: ok in 8 views, fail? in 3 views, fail in 1 view.',
    ...patch,
  };
}

function summaryOf(patch: Partial<TopologyDisagreementSummary> = {}): TopologyDisagreementSummary {
  return {
    status: 'ok',
    sampledAt: AT,
    coverage: {
      nodes: 500,
      asked: 12,
      answered: 12,
      complete: false,
      unanswered: [],
      unansweredCount: 0,
    },
    disagreements: [],
    shards: [shard(0), shard(1), shard(2)],
    ...patch,
  };
}

function show(summary: TopologyDisagreementSummary | undefined, error?: Error) {
  return render(
    <MemoryRouter>
      <ClusterDisagreements summary={summary} error={error} connectionId="conn-1" />
    </MemoryRouter>,
  );
}

function lineOf(text: string): HTMLElement {
  return screen.getByRole('article', { name: text });
}

function sidesOf(line: HTMLElement): HTMLElement[] {
  return within(line).getAllByRole('listitem');
}

function shardRows(): HTMLElement[] {
  return within(screen.getByRole('table', { name: 'Shards' }))
    .getAllByRole('row')
    .slice(1);
}

function largeCluster(): TopologyDisagreementSummary {
  const everyone = Array.from({ length: 25 }, (_, at) => node(`${shardName(at)}p`));
  const cutOff = [node('s001r'), node('s002p'), node('s004r')];
  const slots = slotLine({
    positions: [
      { value: 's000p', owner: node('s000p'), count: 497, observers: everyone },
      { value: 's001p', owner: node('s001p'), count: 3, observers: cutOff },
    ],
    text: 'Slots 0-9: owned by s000p.internal:6379 in 497 views, by s001p.internal:6379 in 3 views.',
  });
  const flags = flagsLine({
    id: 'failure_flags:s010p+3',
    subjects: [node('s010p'), node('s010r'), node('s011p'), node('s011r')],
    subjectCount: 4,
    shardIds: ['s010', 's011'],
    positions: [
      { value: 'ok', count: 496, observers: everyone },
      { value: 'fail?', count: 3, observers: cutOff },
    ],
    text: '4 nodes: ok in 496 views, fail? in 3 views.',
  });
  const disputed = new Map<string, string[]>([
    ['s000', [slots.id]],
    ['s001', [slots.id]],
    ['s010', [flags.id]],
    ['s011', [flags.id]],
  ]);
  const shards = Array.from({ length: 250 }, (_, at) => {
    const ids = disputed.get(shardName(at));
    return shard(at, { ownViews: 2, ...(ids ? { state: 'disputed', disagreementIds: ids } : {}) });
  }).sort((a, b) => Number(b.state === 'disputed') - Number(a.state === 'disputed'));
  return {
    status: 'ok',
    sampledAt: AT,
    coverage: {
      nodes: 500,
      asked: 500,
      answered: 500,
      complete: true,
      unanswered: [],
      unansweredCount: 0,
    },
    disagreements: [slots, flags],
    shards,
  };
}

describe('ClusterDisagreements', () => {
  it('says the cluster is not sampled before the first round', () => {
    show(
      summaryOf({
        status: 'not_sampled',
        sampledAt: null,
        coverage: {
          nodes: 0,
          asked: 0,
          answered: 0,
          complete: false,
          unanswered: [],
          unansweredCount: 0,
        },
        shards: [],
      }),
    );

    expect(screen.getByText('Not sampled yet')).toBeInTheDocument();
    expect(screen.queryByText(/No disagreements/)).not.toBeInTheDocument();
  });

  it('shows a skeleton while the first answer is on its way', () => {
    show(undefined);

    expect(screen.getByRole('status', { name: 'Loading disagreements' })).toBeInTheDocument();
  });

  it('says how many nodes were asked and warns that the rest may disagree', () => {
    show(summaryOf());

    expect(screen.getByText('12 of 500 nodes asked, 12 answered')).toBeInTheDocument();
    expect(screen.getByText('No disagreements among the 12 views compared.')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Counts are over the views that answered. Nodes that were not asked may disagree too.',
      ),
    ).toBeInTheDocument();
  });

  it('drops the warning when every node answered', () => {
    show(
      summaryOf({
        coverage: {
          nodes: 6,
          asked: 6,
          answered: 6,
          complete: true,
          unanswered: [],
          unansweredCount: 0,
        },
      }),
    );

    expect(screen.getByText('All 6 nodes answered')).toBeInTheDocument();
    expect(screen.getByText('No disagreements among the 6 views compared.')).toBeInTheDocument();
    expect(screen.queryByText(/may disagree too/)).not.toBeInTheDocument();
  });

  it('shows a slot owner dispute with the views on each side and links to the nodes', () => {
    show(summaryOf({ disagreements: [slotLine()] }));

    const line = lineOf(slotLine().text);
    expect(within(line).getByText('Critical')).toBeInTheDocument();
    expect(
      within(line).getByText(
        'Slots 0-9: owned by s000p.internal:6379 in 9 views, by s001p.internal:6379 in 3 views.',
      ),
    ).toBeInTheDocument();
    const [first, second] = sidesOf(line);
    expect(within(first).getByText('9 views')).toBeInTheDocument();
    expect(within(first).getByText('+6 more')).toBeInTheDocument();
    expect(within(second).getByText('3 views')).toBeInTheDocument();
    expect(within(second).queryByText(/more/)).not.toBeInTheDocument();
    expect(within(second).getByRole('link', { name: 's002p.internal:6379' })).toHaveAttribute(
      'href',
      '/cluster?connection=conn-1&tab=nodes&node=s002p',
    );
  });

  it('links a confirmed line to the anomalies page and says when one is still counted', () => {
    show(summaryOf({ disagreements: [slotLine(), flagsLine()] }));

    const confirmed = lineOf(slotLine().text);
    const counting = lineOf(flagsLine().text);
    expect(within(confirmed).getByRole('link', { name: 'Open event' })).toHaveAttribute(
      'href',
      '/anomalies',
    );
    expect(within(counting).queryByRole('link', { name: 'Open event' })).not.toBeInTheDocument();
    expect(within(counting).getByText('Not confirmed yet, seen in 2 rounds')).toBeInTheDocument();
  });

  it('tells suspected from failed on a failure line', () => {
    show(summaryOf({ disagreements: [flagsLine()] }));

    const sides = sidesOf(lineOf(flagsLine().text));

    expect(sides).toHaveLength(3);
    expect(within(sides[0]).getByText('ok')).toBeInTheDocument();
    expect(within(sides[1]).getByText('suspected (fail?)')).toBeInTheDocument();
    expect(within(sides[2]).getByText('failed (fail)')).toBeInTheDocument();
    expect(within(sides[2]).getByText('1 view')).toBeInTheDocument();
  });

  it('lists the nodes of a merged line and the epochs each side has for them', () => {
    const merged: DisagreementLine = {
      ...flagsLine(),
      id: 'config_epoch:s001p+1',
      kind: 'config_epoch',
      subjects: [node('s001p'), node('s001r')],
      subjectCount: 2,
      positions: [
        { value: null, count: 2, observers: [node('s000p'), node('s000r')] },
        { value: null, count: 1, observers: [node('s002p')] },
      ],
      epochs: [
        { node: node('s001p'), values: ['7', '4'] },
        { node: node('s001r'), values: ['9', '2'] },
      ],
      text: 'Config epoch of 2 nodes: 2 views against 1 view.',
    };

    show(summaryOf({ disagreements: [merged] }));

    const line = lineOf(merged.text);
    const rows = within(within(line).getByRole('table', { name: 'Epochs per node' })).getAllByRole(
      'row',
    );
    expect(rows.map((row) => row.textContent)).toEqual([
      'NodeSide 1Side 2',
      's001p.internal:637974',
      's001r.internal:637992',
    ]);
    const [first, second] = sidesOf(line);
    expect(within(first).getByText('Side 1')).toBeInTheDocument();
    expect(within(second).getByText('Side 2')).toBeInTheDocument();
  });

  it('says how many more nodes a line is about than it lists', () => {
    const line = flagsLine({
      id: 'failure_flags:s002r+47',
      subjects: [node('s002r'), node('s003r')],
      subjectCount: 48,
      text: '48 nodes: ok in 8 views, fail? in 3 views, fail in 1 view.',
    });

    show(summaryOf({ disagreements: [line] }));

    const about = within(lineOf(line.text)).getByRole('group', {
      name: 'Nodes this line is about',
    });
    expect(within(about).getByRole('link', { name: 's003r.internal:6379' })).toBeInTheDocument();
    expect(within(about).getByText('+46 more')).toBeInTheDocument();
  });

  it('names the nodes that did not answer', () => {
    show(
      summaryOf({
        coverage: {
          nodes: 500,
          asked: 12,
          answered: 10,
          complete: false,
          unanswered: [node('s004p'), node('s005p')],
          unansweredCount: 2,
        },
      }),
    );

    const unanswered = screen.getByRole('group', { name: 'Nodes that did not answer' });
    expect(within(unanswered).getByText('2 nodes did not answer:')).toBeInTheDocument();
    expect(
      within(unanswered).getByRole('link', { name: 's004p.internal:6379' }),
    ).toBeInTheDocument();
    expect(screen.getByText('No disagreements among the 10 views compared.')).toBeInTheDocument();
  });

  it('does not claim agreement when the views could not be compared', () => {
    show(
      summaryOf({
        status: 'insufficient_views',
        coverage: {
          nodes: 6,
          asked: 3,
          answered: 1,
          complete: false,
          unanswered: [],
          unansweredCount: 2,
        },
        shards: [shard(0, { state: 'not_compared' })],
      }),
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Fewer than two nodes answered, so nothing could be compared.',
    );
    expect(screen.queryByText(/No disagreements/)).not.toBeInTheDocument();
    expect(screen.getByText('Not compared')).toBeInTheDocument();
  });

  it('keeps a disagreement the last round could not check apart, without counts', () => {
    const stale = slotLine({
      stale: true,
      lastSeenAt: AT - 60_000,
      positions: [],
      text: 'Slots 0-9: views differed on the owner (s000p.internal:6379, s001p.internal:6379).',
    });
    show(summaryOf({ disagreements: [flagsLine(), stale] }));

    expect(screen.getByText('Disagreements (1)')).toBeInTheDocument();
    const held = screen.getByRole('region', { name: 'Not confirmed this round' });
    expect(held).toHaveTextContent(
      '1 disagreement from an earlier round could not be checked again in the last round. It is neither confirmed nor cleared.',
    );
    const card = within(held).getByRole('article', { name: stale.text });
    expect(card).toHaveTextContent(
      `Last seen ${new Date(AT - 60_000).toLocaleTimeString()}, not confirmed this round`,
    );
    expect(within(card).queryAllByRole('listitem')).toHaveLength(0);
    expect(within(card).getByRole('link', { name: 'Open event' })).toBeInTheDocument();
    expect(within(held).queryByRole('article', { name: flagsLine().text })).not.toBeInTheDocument();
  });

  it('shows what was seen before without counts when the views could not be compared', () => {
    const stale = flagsLine({
      stale: true,
      lastSeenAt: AT - 5000,
      positions: [],
      text: 's002r.internal:6379: views differed on whether it is failing.',
    });
    show(
      summaryOf({
        status: 'insufficient_views',
        disagreements: [stale],
        shards: [shard(2, { state: 'not_compared' })],
      }),
    );

    expect(screen.getByText('Disagreements (0)')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('nothing could be compared');
    expect(
      within(screen.getByRole('region', { name: 'Not confirmed this round' })).getByRole(
        'article',
        {
          name: stale.text,
        },
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No disagreements/)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /1 disagreement$/ })).not.toBeInTheDocument();
  });

  it('does not claim agreement when the summary could not be loaded', () => {
    show(undefined, new Error('boom'));

    expect(screen.getByRole('alert')).toHaveTextContent(
      'The disagreements could not be loaded. This does not mean the views agree.',
    );
    expect(screen.queryByText(/No disagreements/)).not.toBeInTheDocument();
  });

  it('keeps the last summary on screen when a refresh fails', () => {
    show(summaryOf({ disagreements: [slotLine()] }), new Error('boom'));

    expect(screen.getByRole('alert')).toHaveTextContent('could not be refreshed');
    expect(lineOf(slotLine().text)).toBeInTheDocument();
  });

  it('shows one row per shard, disputed ones with a link to their disagreement', () => {
    const line = slotLine();
    show(
      summaryOf({
        disagreements: [line],
        shards: [
          shard(0, { state: 'disputed', disagreementIds: [line.id], ownViews: 2 }),
          shard(1, { state: 'disputed', disagreementIds: [line.id], ownViews: 1 }),
          shard(2),
        ],
      }),
    );

    const rows = shardRows();
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText('Disputed')).toBeInTheDocument();
    expect(within(rows[0]).getByRole('link', { name: '1 disagreement' })).toHaveAttribute(
      'href',
      '#disagreement-slot_owner:s000p|s001p',
    );
    expect(within(rows[0]).getByText('2 of 2 nodes answered')).toBeInTheDocument();
    expect(within(rows[1]).getByText('1 of 2 nodes answered')).toBeInTheDocument();
    expect(within(rows[2]).getByText('No disagreement')).toBeInTheDocument();
    expect(within(rows[2]).getByText('No view from its 2 nodes')).toBeInTheDocument();
    expect(within(rows[2]).getByText('130-194')).toBeInTheDocument();
    expect(within(rows[2]).getByRole('link', { name: 's002p.internal:6379' })).toHaveAttribute(
      'href',
      '/cluster?connection=conn-1&tab=nodes&node=s002p',
    );
  });

  it('hides the undisputed shards on request', () => {
    const line = slotLine();
    show(
      summaryOf({
        disagreements: [line],
        shards: [shard(0, { state: 'disputed', disagreementIds: [line.id] }), shard(1), shard(2)],
      }),
    );

    fireEvent.click(screen.getByRole('switch', { name: 'Only disputed' }));

    expect(shardRows()).toHaveLength(1);
    expect(screen.getByText('Shards (1 of 3)')).toBeInTheDocument();
  });

  it('renders a 500-node cluster with only the disagreements expanded', () => {
    show(largeCluster());

    expect(screen.getByText('All 500 nodes answered')).toBeInTheDocument();
    expect(shardRows()).toHaveLength(250);
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    expect(screen.getByText('4 nodes: ok in 496 views, fail? in 3 views.')).toBeInTheDocument();
    expect(screen.getByText('497 views')).toBeInTheDocument();
    expect(screen.getAllByText('+472 more')).toHaveLength(1);
    const undisputed = shardRows().filter((row) => within(row).queryByText('No disagreement'));
    expect(undisputed).toHaveLength(246);
    expect(undisputed.every((row) => within(row).getAllByRole('link').length === 1)).toBe(true);
  });
});
