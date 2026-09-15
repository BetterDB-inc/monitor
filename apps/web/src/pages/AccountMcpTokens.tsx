import { ReactElement } from 'react';
import { Navigate } from 'react-router-dom';
import { McpTokensPanel } from '../components/pages/settings/McpTokensPanel';
import { useDemoState } from '../contexts/DemoContext';

export function AccountMcpTokens(): ReactElement | null {
  const { isDemo, loading } = useDemoState();
  if (loading === true) {
    return null;
  }
  if (isDemo === true) {
    return <Navigate to="/" replace />;
  }
  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-3xl font-bold">MCP Tokens</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage the personal tokens you use to connect MCP clients, such as Claude Code, to this
          workspace.
        </p>
      </div>
      <McpTokensPanel />
    </div>
  );
}
