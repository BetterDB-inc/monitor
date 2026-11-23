import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { CrossReferenceResult } from '../../api/monitor';
import { CrossReferenceSections } from './cross-reference-panel';

const TITLE = 'Top keys in this capture';

function result(overrides: Partial<CrossReferenceResult> = {}): CrossReferenceResult {
  return {
    sessionId: 'sess-1',
    baseline: { window: '24h', startTs: 0, endTs: 1 },
    session: { startTs: 1, endTs: 2, capturedLineCount: 4 },
    newShapes: [],
    topKeys: [
      { key: 'user:42', count: 3, share: 0.75 },
      { key: 'cart:9', count: 1, share: 0.25 },
    ],
    hotKeyDelta: { newInTopK: [], rankChanges: [] },
    slowlogRegressions: [],
    aclDeltas: {
      auditEntriesInWindow: 0,
      counters: { aclAccessDeniedAuthDelta: null, rejectedConnectionsDelta: null },
    },
    ...overrides,
  };
}

describe('CrossReferenceSections top keys', () => {
  it('lists the keys of the capture with their command count and share', () => {
    render(<CrossReferenceSections result={result()} />);

    expect(screen.getByText(TITLE)).toBeInTheDocument();
    const rows = screen.getAllByRole('listitem').map((row) => row.textContent);
    expect(rows).toEqual(['user:42×3 (75%)', 'cart:9×1 (25%)']);
  });

  it('says so when the capture holds no keyed commands', () => {
    render(<CrossReferenceSections result={result({ topKeys: [] })} />);

    expect(screen.getByText(TITLE)).toBeInTheDocument();
    expect(screen.getByText('No keyed commands in this capture.')).toBeInTheDocument();
  });

  it('renders the other sections when the server sends no top keys', () => {
    const { topKeys: _omitted, ...older } = result();

    render(<CrossReferenceSections result={older} />);

    expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
    expect(screen.getByText('Hot-key delta')).toBeInTheDocument();
    expect(screen.getByText('New command shapes')).toBeInTheDocument();
  });
});
