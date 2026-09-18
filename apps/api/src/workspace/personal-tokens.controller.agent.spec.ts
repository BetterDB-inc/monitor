import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Actor, AgentConnectionInfo, AgentToken } from '@betterdb/shared';
import { ActivityService } from '../activity/activity.service';
import { PersonalTokenService } from './personal-token.service';
import { PersonalTokensController } from './personal-tokens.controller';

// Unit tests for the agent-token routing added for self-hosted agent connections.
// The proprietary AgentTokensService + AgentGateway are mocked structurally.

const ACTOR: Actor = {
  userId: 'user-1',
  email: 'owner@example.com',
  role: 'admin',
  isOwner: true,
  via: 'session',
  tokenId: null,
};

const REQ = { headers: {}, ip: '127.0.0.1' } as unknown as FastifyRequest;

function agentTokenRecord(overrides: Partial<AgentToken> = {}): AgentToken {
  return {
    id: 'agent-token-1',
    name: 'ci-agent',
    type: 'agent',
    tokenHash: 'hash',
    createdAt: 1,
    expiresAt: 2,
    revokedAt: null,
    lastUsedAt: null,
    userId: null,
    ...overrides,
  };
}

function build(options: { withAgent: boolean; withGateway: boolean }) {
  const personal = {
    generate: jest.fn(),
    list: jest.fn().mockResolvedValue([]),
    revoke: jest.fn(),
  } as unknown as PersonalTokenService;
  const activity = { record: jest.fn() } as unknown as ActivityService;
  const agentTokens = options.withAgent
    ? {
        generateToken: jest
          .fn()
          .mockResolvedValue({ token: 'jwt.token.value', metadata: agentTokenRecord() }),
        listTokens: jest.fn().mockResolvedValue([agentTokenRecord()]),
        revokeToken: jest.fn().mockResolvedValue(undefined),
      }
    : null;
  const connections: AgentConnectionInfo[] = [
    {
      id: 'conn-1',
      tokenId: 'agent-token-1',
      name: 'ci-agent',
      connectedAt: 100,
      agentVersion: '1.6.1',
      valkey: { type: 'valkey', version: '8.1', tls: false, cluster: false },
    },
  ];
  const gateway = options.withGateway
    ? { getConnectedAgents: jest.fn().mockReturnValue(connections) }
    : null;
  const controller = new PersonalTokensController(
    personal,
    activity,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agentTokens as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    gateway as any,
  );
  return { controller, personal, activity, agentTokens, gateway, connections };
}

describe('PersonalTokensController agent routing', () => {
  it('mints an agent token via the agent service when type=agent', async () => {
    const { controller, agentTokens, personal } = build({ withAgent: true, withGateway: true });
    const result = await controller.create({ name: 'ci-agent', type: 'agent' }, ACTOR, REQ);
    expect(agentTokens?.generateToken).toHaveBeenCalledWith('ci-agent', 'agent');
    expect(personal.generate).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({ token: 'jwt.token.value', id: 'agent-token-1', type: 'agent' }),
    );
  });

  it('still mints an mcp token via the personal service when type=mcp', async () => {
    const { controller, personal, agentTokens } = build({ withAgent: true, withGateway: true });
    (personal.generate as jest.Mock).mockResolvedValue({
      token: 'bdb_mcp_x',
      metadata: agentTokenRecord({ id: 'mcp-1', type: 'mcp', userId: 'user-1' }),
    });
    const result = await controller.create({ name: 'laptop', type: 'mcp' }, ACTOR, REQ);
    expect(personal.generate).toHaveBeenCalledWith('laptop', ACTOR);
    expect(agentTokens?.generateToken).not.toHaveBeenCalled();
    expect(result.type).toBe('mcp');
  });

  it('reports agent minting as unavailable when the agent service is absent', async () => {
    const { controller } = build({ withAgent: false, withGateway: false });
    await expect(
      controller.create({ name: 'ci-agent', type: 'agent' }, ACTOR, REQ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('lists agent tokens mapped to the personal token view', async () => {
    const { controller, agentTokens } = build({ withAgent: true, withGateway: true });
    const tokens = await controller.list(ACTOR, 'agent');
    expect(agentTokens?.listTokens).toHaveBeenCalledWith('agent');
    expect(tokens).toEqual([
      expect.objectContaining({ id: 'agent-token-1', type: 'agent', userId: null, ownerEmail: null }),
    ]);
  });

  it('returns connected agents from the gateway, or [] when absent', async () => {
    const withGw = build({ withAgent: true, withGateway: true });
    expect(withGw.controller.getConnections()).toEqual(withGw.connections);

    const noGw = build({ withAgent: true, withGateway: false });
    expect(noGw.controller.getConnections()).toEqual([]);
  });

  it('falls back to agent revoke only for genuine agent tokens', async () => {
    const { controller, personal, agentTokens } = build({ withAgent: true, withGateway: true });
    (personal.revoke as jest.Mock).mockRejectedValue(new NotFoundException('Token not found'));
    const result = await controller.revoke('agent-token-1', ACTOR, REQ);
    expect(result).toEqual({ revoked: true });
    expect(agentTokens?.revokeToken).toHaveBeenCalledWith('agent-token-1');
  });

  it('rethrows NotFound when the id is neither an mcp nor an agent token', async () => {
    const { controller, personal, agentTokens } = build({ withAgent: true, withGateway: true });
    (personal.revoke as jest.Mock).mockRejectedValue(new NotFoundException('Token not found'));
    await expect(controller.revoke('unknown-id', ACTOR, REQ)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(agentTokens?.revokeToken).not.toHaveBeenCalled();
  });
});
