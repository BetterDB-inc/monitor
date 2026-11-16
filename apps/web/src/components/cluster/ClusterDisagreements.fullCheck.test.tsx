import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ClusterDisagreements } from './ClusterDisagreements';
import type {
  DisagreementLine,
  DivergenceNode,
  TopologyDisagreementReport,
  TopologyDisagreementSummary,
  TopologyFullCheck,
} from '@/types/anomaly';

const SAMPLED_TEXT =
  'Slots 0-9: owned by s000p.internal:6379 in 9 views, by s001p.internal:6379 in 3 views.';
const FULL_TEXT =
  'Slots 0-9: owned by s000p.internal:6379 in 497 views, by s001p.internal:6379 in 3 views.';

function node(nodeId: string): DivergenceNode {
  return { nodeId, address: `${nodeId}.internal:6379`, role: 'primary' };
}

function slotLine(patch: Partial<DisagreementLine> = {}): DisagreementLine {
  return {
    id: 'slot_owner:s000p|s001p',
    kind: 'slot_owner',
    severity: 'critical',
    confirmed: false,
    eventId: null,
    eventType: null,
    tracked: true,
    since: Date.now() - 30_000,
    rounds: 2,
    stale: false,
    lastSeenAt: Date.now(),
    subjects: [node('s000p'), node('s001p')],
    subjectCount: 2,
    slots: [[0, 9]],
    slotCount: 10,
    shardIds: ['s000', 's001'],
    positions: [
      { value: 's000p', owner: node('s000p'), count: 9, observers: [node('s000p')] },
      { value: 's001p', owner: node('s001p'), count: 3, observers: [node('s001p')] },
    ],
    text: SAMPLED_TEXT,
    ...patch,
  };
}

function summaryOf(patch: Partial<TopologyDisagreementSummary> = {}): TopologyDisagreementSummary {
  return {
    status: 'ok',
    sampledAt: Date.now() - 2_000,
    coverage: {
      nodes: 500,
      asked: 12,
      answered: 12,
      complete: false,
      unanswered: [],
      unansweredCount: 0,
    },
    disagreements: [slotLine()],
    shards: [],
    ...patch,
  };
}

function checkOf(patch: Partial<TopologyFullCheck> = {}): TopologyFullCheck {
  return {
    state: 'none',
    unavailable: null,
    startedAt: null,
    finishedAt: null,
    asked: 0,
    total: 0,
    retryAt: null,
    ...patch,
  };
}

function doneCheck(finishedAt: number, patch: Partial<TopologyDisagreementSummary> = {}) {
  const {
    since: _since,
    rounds: _rounds,
    ...untracked
  } = slotLine({
    tracked: false,
    positions: [
      { value: 's000p', owner: node('s000p'), count: 497, observers: [node('s000p')] },
      { value: 's001p', owner: node('s001p'), count: 3, observers: [node('s001p')] },
    ],
    text: FULL_TEXT,
  });
  return checkOf({
    state: 'done',
    startedAt: finishedAt - 900,
    finishedAt,
    asked: 500,
    total: 500,
    retryAt: finishedAt + 30_000,
    summary: summaryOf({
      sampledAt: finishedAt,
      coverage: {
        nodes: 500,
        asked: 500,
        answered: 500,
        complete: true,
        unanswered: [],
        unansweredCount: 0,
      },
      disagreements: [untracked],
      ...patch,
    }),
  });
}

function reportOf(
  fullCheck: TopologyFullCheck | undefined,
  patch: Partial<TopologyDisagreementSummary> = {},
): TopologyDisagreementReport {
  return { ...summaryOf(patch), ...(fullCheck ? { fullCheck } : {}) };
}

interface Extra {
  onAskEveryNode?: () => void;
  asking?: boolean;
  askError?: Error | null;
}

function view(report: TopologyDisagreementReport, extra: Extra = {}) {
  return (
    <MemoryRouter>
      <ClusterDisagreements summary={report} connectionId="conn-1" {...extra} />
    </MemoryRouter>
  );
}

function fullButtonName(finishedAt: number, answered = 500): string {
  return `Full check ${new Date(finishedAt).toLocaleTimeString()} · ${answered} of 500 answered`;
}

describe('ClusterDisagreements full check', () => {
  it('offers nothing when the answer carries no full check', () => {
    render(view(reportOf(undefined)));

    expect(screen.queryByRole('button', { name: 'Ask every node' })).not.toBeInTheDocument();
  });

  it('offers to ask every node and passes the request on', () => {
    const onAskEveryNode = vi.fn();
    render(view(reportOf(checkOf()), { onAskEveryNode }));

    fireEvent.click(screen.getByRole('button', { name: 'Ask every node' }));

    expect(onAskEveryNode).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('group', { name: 'Result shown' })).not.toBeInTheDocument();
  });

  it('gives the reason in place of the button where the check cannot be run', () => {
    const text =
      'The nodes of a Raft cluster share one agreed view, so there is nothing to compare.';
    render(view(reportOf(checkOf({ unavailable: { reason: 'raft_cluster', text } }))));

    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ask every node' })).not.toBeInTheDocument();
  });

  it('is offered on a cluster that is not sampled', () => {
    render(
      view(
        reportOf(checkOf(), {
          status: 'not_sampled',
          sampledAt: null,
          disagreements: [],
        }),
      ),
    );

    expect(screen.getByText('Not sampled yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask every node' })).toBeEnabled();
  });

  it('shows how far a running check is and does not offer a second one', () => {
    render(
      view(reportOf(checkOf({ state: 'running', startedAt: Date.now(), asked: 312, total: 500 }))),
    );

    expect(screen.getByRole('status', { name: 'Full check progress' })).toHaveTextContent(
      'Asking every node: 312 of 500 asked',
    );
    expect(screen.getByRole('button', { name: 'Ask every node' })).toBeDisabled();
  });

  it('does not offer a second check while the request is on its way', () => {
    render(view(reportOf(checkOf()), { asking: true }));

    expect(screen.getByRole('button', { name: 'Ask every node' })).toBeDisabled();
  });

  it('says why a check was refused', () => {
    render(
      view(reportOf(checkOf()), {
        askError: new Error('The last full check finished less than 30 seconds ago'),
      }),
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'The last full check finished less than 30 seconds ago',
    );
  });

  it('keeps the sampled result on screen until the full one is picked', () => {
    const finishedAt = Date.now() - 5_000;
    render(view(reportOf(doneCheck(finishedAt))));

    const choice = screen.getByRole('group', { name: 'Result shown' });
    const sampled = within(choice).getByRole('button', { name: 'Sampled (live)' });
    const full = within(choice).getByRole('button', { name: fullButtonName(finishedAt) });
    expect(sampled).toHaveAttribute('aria-pressed', 'true');
    expect(full).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('article', { name: SAMPLED_TEXT })).toBeInTheDocument();

    fireEvent.click(full);

    expect(full).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('article', { name: SAMPLED_TEXT })).not.toBeInTheDocument();
    const line = screen.getByRole('article', { name: FULL_TEXT });
    expect(within(line).getByText('497 views')).toBeInTheDocument();
    expect(within(line).getByText('One-off check, not tracked')).toBeInTheDocument();
    expect(within(line).queryByText(/^since /)).not.toBeInTheDocument();
    expect(within(line).queryByText(/Not confirmed yet/)).not.toBeInTheDocument();
    expect(screen.getByText('All 500 nodes answered')).toBeInTheDocument();
    expect(
      screen.getByText(
        `One-off check taken ${new Date(finishedAt).toLocaleTimeString()}. It does not update.`,
      ),
    ).toBeInTheDocument();

    fireEvent.click(sampled);

    expect(screen.getByRole('article', { name: SAMPLED_TEXT })).toBeInTheDocument();
  });

  it('links a full check line to the event that tracks the same disagreement', () => {
    const finishedAt = Date.now() - 5_000;
    const check = doneCheck(finishedAt);
    check.summary!.disagreements = check.summary!.disagreements.map((line) => ({
      ...line,
      confirmed: true,
      eventId: 'event-1',
      eventType: 'topology_divergence',
    }));
    render(view(reportOf(check)));

    fireEvent.click(screen.getByRole('button', { name: fullButtonName(finishedAt) }));

    const line = screen.getByRole('article', { name: FULL_TEXT });
    expect(within(line).getByRole('link', { name: 'Open event' })).toHaveAttribute(
      'href',
      '/anomalies',
    );
  });

  it('switches to the full result when the check that was asked for finishes', () => {
    const onAskEveryNode = vi.fn();
    const { rerender } = render(view(reportOf(checkOf()), { onAskEveryNode }));

    fireEvent.click(screen.getByRole('button', { name: 'Ask every node' }));
    rerender(
      view(reportOf(checkOf({ state: 'running', startedAt: Date.now(), asked: 16, total: 500 })), {
        onAskEveryNode,
      }),
    );
    expect(screen.getByRole('article', { name: SAMPLED_TEXT })).toBeInTheDocument();

    rerender(view(reportOf(doneCheck(Date.now())), { onAskEveryNode }));

    expect(screen.getByRole('article', { name: FULL_TEXT })).toBeInTheDocument();
  });

  it('does not switch for a check that someone else ran', () => {
    const { rerender } = render(view(reportOf(checkOf())));

    rerender(view(reportOf(doneCheck(Date.now()))));

    expect(screen.getByRole('article', { name: SAMPLED_TEXT })).toBeInTheDocument();
  });

  it('marks a full result older than a minute as possibly out of date', () => {
    const finishedAt = Date.now() - 3 * 60_000;
    render(view(reportOf(doneCheck(finishedAt))));

    fireEvent.click(screen.getByRole('button', { name: fullButtonName(finishedAt) }));

    expect(
      screen.getByText('Taken 3 minutes ago. The cluster may have changed since.'),
    ).toBeInTheDocument();
  });

  it('does not count a node that gave no answer as agreeing', () => {
    const finishedAt = Date.now() - 5_000;
    const check = doneCheck(finishedAt, {
      coverage: {
        nodes: 500,
        asked: 500,
        answered: 497,
        complete: false,
        unanswered: [node('s007p'), node('s008p'), node('s009p')],
        unansweredCount: 3,
      },
    });
    render(view(reportOf(check)));

    fireEvent.click(screen.getByRole('button', { name: fullButtonName(finishedAt, 497) }));

    expect(
      screen.getByText(
        'Counts are over the nodes that answered. A node that gave no answer is not counted as agreeing.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('3 nodes did not answer:')).toBeInTheDocument();
    expect(
      screen.queryByText(/Nodes that were not asked may disagree too/),
    ).not.toBeInTheDocument();
  });

  it('goes back to the sampled result when the full one is no longer kept', () => {
    const finishedAt = Date.now() - 5_000;
    const { rerender } = render(view(reportOf(doneCheck(finishedAt))));
    fireEvent.click(screen.getByRole('button', { name: fullButtonName(finishedAt) }));

    rerender(view(reportOf(checkOf())));

    expect(screen.getByRole('article', { name: SAMPLED_TEXT })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Result shown' })).not.toBeInTheDocument();

    rerender(view(reportOf(doneCheck(Date.now()))));

    expect(screen.getByRole('article', { name: SAMPLED_TEXT })).toBeInTheDocument();
  });

  it('does not switch after a refused request when a later check finishes', () => {
    const { rerender } = render(view(reportOf(checkOf())));
    fireEvent.click(screen.getByRole('button', { name: 'Ask every node' }));

    rerender(view(reportOf(checkOf()), { askError: new Error('refused') }));
    rerender(view(reportOf(doneCheck(Date.now())), { askError: new Error('refused') }));

    expect(screen.getByRole('article', { name: SAMPLED_TEXT })).toBeInTheDocument();
  });
});
