import type { IncomingMessage } from 'http';
import type { Socket } from 'net';
import type { WorkspaceMode } from '@betterdb/shared';

export interface AgentUpgradeGateway {
  handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void;
}

// Minimal shape of the Nest application we depend on, so this stays unit-testable
// without constructing a full NestApplication.
interface GatewayResolver {
  get(token: unknown): unknown;
}

/**
 * Resolve the agent WebSocket gateway, or null when it is not available.
 *
 * The AgentGateway provider only exists in cloud mode (AgentModule) or
 * self-hosted mode (SelfHostedAgentModule). Under WORKSPACE_DISABLED neither is
 * loaded, so we skip the lookup entirely: calling app.get() for an unregistered
 * provider throws, and with abortOnError:false the try/catch here handles it,
 * but skipping avoids a noisy logged error on the normal disabled path.
 *
 * The try/catch also covers the edge case where the agent module fails to load
 * in self-hosted mode (it logs a warning and keeps booting, leaving the provider
 * absent) and the case where the proprietary agent code simply isn't built
 * (require throws). In every "not available" case this returns null instead of
 * crashing bootstrap.
 *
 * requireGateway is injected so the proprietary require stays lexically in the
 * caller (its relative path resolves against main.js at runtime) and so tests
 * can stub it.
 */
export function resolveAgentGateway(
  app: GatewayResolver,
  mode: WorkspaceMode,
  requireGateway: () => { AgentGateway: unknown },
): AgentUpgradeGateway | null {
  if (mode === 'disabled') {
    return null;
  }
  try {
    const { AgentGateway } = requireGateway();
    const gw = app.get(AgentGateway) as AgentUpgradeGateway;
    console.log('[Agent] WebSocket gateway resolved');
    return gw;
  } catch {
    console.warn('[Agent] WebSocket gateway not registered, agent connections disabled');
    return null;
  }
}
