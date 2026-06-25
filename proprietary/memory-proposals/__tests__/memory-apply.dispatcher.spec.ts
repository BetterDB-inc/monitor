import type { StoredMemoryProposal } from '@betterdb/shared';
import type { ConnectionRegistry } from '@app/connections/connection-registry.service';

const mockForget = jest.fn();
const mockForgetByScope = jest.fn();

jest.mock('@betterdb/agent-memory', () => ({
  MemoryStore: jest.fn().mockImplementation(() => ({
    forget: mockForget,
    forgetByScope: mockForgetByScope,
  })),
}));

import { MemoryApplyDispatcher } from '../memory-apply.dispatcher';

function makeRegistry(): ConnectionRegistry {
  return {
    get: jest.fn(() => ({ getClient: () => ({}) })),
  } as unknown as ConnectionRegistry;
}

function proposal(payload: StoredMemoryProposal['proposal_payload']): StoredMemoryProposal {
  return {
    id: 'p1',
    connection_id: 'conn-1',
    store_name: 'betterdb_ac',
    proposal_type: 'forget',
    proposal_payload: payload,
    reasoning: 'removing as requested by the user account',
    status: 'approved',
    proposed_by: null,
    proposed_at: 1,
    reviewed_by: null,
    reviewed_at: null,
    applied_at: null,
    applied_result: null,
    expires_at: 9_999_999_999_999,
  };
}

describe('MemoryApplyDispatcher', () => {
  beforeEach(() => {
    mockForget.mockReset();
    mockForgetByScope.mockReset();
  });

  it('forgets a single memory by id', async () => {
    mockForget.mockResolvedValue(true);
    const dispatcher = new MemoryApplyDispatcher(makeRegistry());

    const outcome = await dispatcher.dispatch(proposal({ target_kind: 'id', memory_id: 'm1' }));

    expect(mockForget).toHaveBeenCalledWith('m1');
    expect(outcome.actualAffected).toBe(1);
    expect(outcome.details).toMatchObject({ target_kind: 'id', memory_id: 'm1', removed: true });
  });

  it('reports zero affected when the id did not exist', async () => {
    mockForget.mockResolvedValue(false);
    const dispatcher = new MemoryApplyDispatcher(makeRegistry());

    const outcome = await dispatcher.dispatch(proposal({ target_kind: 'id', memory_id: 'gone' }));

    expect(outcome.actualAffected).toBe(0);
  });

  it('forgets by scope and tags, returning the removed count', async () => {
    mockForgetByScope.mockResolvedValue(3);
    const dispatcher = new MemoryApplyDispatcher(makeRegistry());

    const outcome = await dispatcher.dispatch(
      proposal({ target_kind: 'scope', scope: { threadId: 't1' }, tags: ['pref'] }),
    );

    expect(mockForgetByScope).toHaveBeenCalledWith({ threadId: 't1', tags: ['pref'] });
    expect(outcome.actualAffected).toBe(3);
    expect(outcome.details).toMatchObject({ target_kind: 'scope', removed: 3 });
  });
});
