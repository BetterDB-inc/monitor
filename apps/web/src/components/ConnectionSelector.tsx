import { useState, useEffect, useRef } from 'react';
import { useConnection } from '../hooks/useConnection';
import { fetchApi } from '../api/client';
import { agentTokensApi, GeneratedToken, TokenListItem } from '../api/agent-tokens';
import type { AgentConnectionInfo } from '@betterdb/shared';

interface ConnectionFormData {
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  dbIndex: number;
  tls: boolean;
}

const defaultFormData: ConnectionFormData = {
  name: '',
  host: 'localhost',
  port: 6379,
  username: '',
  password: '',
  dbIndex: 0,
  tls: false,
};

type AddTab = 'direct' | 'agent';

export function ConnectionSelector({ isCloudMode }: { isCloudMode?: boolean }) {
  const { currentConnection, connections, loading, error, setConnection, refreshConnections } = useConnection();
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showManageDialog, setShowManageDialog] = useState(false);
  const [formData, setFormData] = useState<ConnectionFormData>(defaultFormData);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [addTab, setAddTab] = useState<AddTab>('direct');

  const handleInputChange = (field: keyof ConnectionFormData, value: string | number | boolean) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    setTestResult(null);
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await fetchApi<{ success: boolean; message?: string; error?: string }>('/connections/test', {
        method: 'POST',
        body: JSON.stringify({
          name: formData.name || 'Test',
          host: formData.host,
          port: formData.port,
          username: formData.username || undefined,
          password: formData.password || undefined,
          dbIndex: formData.dbIndex,
          tls: formData.tls,
        }),
      });
      setTestResult({
        success: result.success,
        message: result.success ? 'Connection successful!' : (result.error || 'Connection failed'),
      });
    } catch (err) {
      setTestResult({
        success: false,
        message: err instanceof Error ? err.message : 'Connection test failed',
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSaveConnection = async () => {
    if (!formData.name || !formData.host) {
      setTestResult({ success: false, message: 'Name and host are required' });
      return;
    }

    setSaving(true);
    try {
      await fetchApi<{ id: string }>('/connections', {
        method: 'POST',
        body: JSON.stringify({
          name: formData.name,
          host: formData.host,
          port: formData.port,
          username: formData.username || undefined,
          password: formData.password || undefined,
          dbIndex: formData.dbIndex,
          tls: formData.tls,
          setAsDefault: connections.length === 0,
        }),
      });
      setShowAddDialog(false);
      setFormData(defaultFormData);
      setTestResult(null);
      await refreshConnections();
    } catch (err) {
      setTestResult({
        success: false,
        message: err instanceof Error ? err.message : 'Failed to save connection',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteConnection = async (id: string) => {
    if (!confirm('Are you sure you want to delete this connection?')) return;

    try {
      await fetchApi(`/connections/${id}`, { method: 'DELETE' });
      await refreshConnections();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete connection');
    }
  };

  const handleSetDefault = async (id: string) => {
    try {
      await fetchApi(`/connections/${id}/default`, { method: 'POST' });
      await refreshConnections();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to set default');
    }
  };

  if (loading) {
    return (
      <div className="px-3 py-2 text-sm text-muted-foreground">
        Loading connections...
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-3 py-2">
        <div className="text-sm text-red-500 mb-2">{error}</div>
        <button
          onClick={() => setShowAddDialog(true)}
          className="text-xs text-primary hover:underline"
        >
          + Add Connection
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="px-3 py-2">
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs text-muted-foreground">Connection</label>
          <div className="flex gap-1">
            <button
              onClick={() => setShowAddDialog(true)}
              className="text-xs text-primary hover:underline"
              title="Add connection"
            >
              +
            </button>
            {connections.length > 0 && (
              <button
                onClick={() => setShowManageDialog(true)}
                className="text-xs text-muted-foreground hover:text-foreground"
                title="Manage connections"
              >
                ⚙
              </button>
            )}
          </div>
        </div>

        {connections.length === 0 ? (
          <button
            onClick={() => setShowAddDialog(true)}
            className="w-full px-2 py-1.5 text-sm border border-dashed rounded-md hover:border-primary hover:text-primary transition-colors"
          >
            + Add your first connection
          </button>
        ) : connections.length === 1 ? (
          <div className="flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full flex-shrink-0 ${connections[0].isConnected ? 'bg-green-500' : 'bg-red-500'}`}
            />
            <div className="min-w-0">
              <span className="text-sm font-medium truncate block">{connections[0].name}</span>
              <span className="text-xs text-muted-foreground">{connections[0].host}:{connections[0].port}</span>
            </div>
          </div>
        ) : (
          <select
            value={currentConnection?.id ?? ''}
            onChange={(e) => setConnection(e.target.value)}
            className="w-full px-2 py-1.5 text-sm bg-background border rounded-md focus:outline-none focus:ring-2 focus:ring-primary"
          >
            {connections.map((conn) => (
              <option key={conn.id} value={conn.id}>
                {conn.isConnected ? '● ' : '○ '}{conn.name} ({conn.host}:{conn.port})
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Add Connection Dialog */}
      {showAddDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-background border rounded-lg shadow-lg w-full max-w-md mx-4">
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <h2 className="text-lg font-semibold">Add Connection</h2>
              <button
                onClick={() => {
                  setShowAddDialog(false);
                  setFormData(defaultFormData);
                  setTestResult(null);
                }}
                className="text-muted-foreground hover:text-foreground"
              >
                ✕
              </button>
            </div>

            {/* Tab switcher (only if cloud mode) */}
            {isCloudMode && (
              <div className="flex border-b">
                <button
                  onClick={() => setAddTab('direct')}
                  className={`flex-1 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${addTab === 'direct'
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                    }`}
                >
                  Direct Connection
                </button>
                <button
                  onClick={() => setAddTab('agent')}
                  className={`flex-1 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${addTab === 'agent'
                    ? 'border-primary text-primary'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                    }`}
                >
                  Via Agent
                </button>
              </div>
            )}

            {addTab === 'direct' ? (
              <>
                <div className="p-4 space-y-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">Name *</label>
                    <input
                      type="text"
                      value={formData.name}
                      onChange={(e) => handleInputChange('name', e.target.value)}
                      placeholder="Production Redis"
                      className="w-full px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary"
                    />
                  </div>

                  <div className="grid grid-cols-3 gap-3">
                    <div className="col-span-2">
                      <label className="block text-sm font-medium mb-1">Host *</label>
                      <input
                        type="text"
                        value={formData.host}
                        onChange={(e) => handleInputChange('host', e.target.value)}
                        placeholder="localhost"
                        className="w-full px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Port</label>
                      <input
                        type="number"
                        value={formData.port}
                        onChange={(e) => handleInputChange('port', parseInt(e.target.value) || 6379)}
                        className="w-full px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium mb-1">Username</label>
                      <input
                        type="text"
                        value={formData.username}
                        onChange={(e) => handleInputChange('username', e.target.value)}
                        placeholder="default"
                        className="w-full px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium mb-1">Password</label>
                      <input
                        type="password"
                        value={formData.password}
                        onChange={(e) => handleInputChange('password', e.target.value)}
                        className="w-full px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-sm font-medium mb-1">Database Index</label>
                      <input
                        type="number"
                        value={formData.dbIndex}
                        onChange={(e) => handleInputChange('dbIndex', parseInt(e.target.value) || 0)}
                        min="0"
                        max="15"
                        className="w-full px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary"
                      />
                    </div>
                    <div className="flex items-end pb-2">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={formData.tls}
                          onChange={(e) => handleInputChange('tls', e.target.checked)}
                          className="rounded"
                        />
                        <span className="text-sm">Use TLS</span>
                      </label>
                    </div>
                  </div>

                  {testResult && (
                    <div className={`p-3 rounded-md text-sm ${testResult.success ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}`}>
                      {testResult.message}
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between px-4 py-3 border-t bg-muted/30">
                  <button
                    onClick={handleTestConnection}
                    disabled={testing || !formData.host}
                    className="px-4 py-2 text-sm border rounded-md hover:bg-muted disabled:opacity-50"
                  >
                    {testing ? 'Testing...' : 'Test Connection'}
                  </button>
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        setShowAddDialog(false);
                        setFormData(defaultFormData);
                        setTestResult(null);
                      }}
                      className="px-4 py-2 text-sm border rounded-md hover:bg-muted"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleSaveConnection}
                      disabled={saving || !formData.name || !formData.host}
                      className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
                    >
                      {saving ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <AgentTab
                onClose={() => {
                  setShowAddDialog(false);
                  setAddTab('direct');
                }}
                onAgentConnected={refreshConnections}
              />
            )}
          </div>
        </div>
      )}

      {/* Manage Connections Dialog */}
      {showManageDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-background border rounded-lg shadow-lg w-full max-w-lg mx-4">
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <h2 className="text-lg font-semibold">Manage Connections</h2>
              <button
                onClick={() => setShowManageDialog(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                ✕
              </button>
            </div>

            <div className="p-4 space-y-2 max-h-96 overflow-y-auto">
              {connections.map((conn) => (
                <div
                  key={conn.id}
                  className={`flex items-center justify-between p-3 border rounded-md ${currentConnection?.id === conn.id ? 'border-primary bg-primary/5' : ''
                    }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      className={`w-2 h-2 rounded-full flex-shrink-0 ${conn.isConnected ? 'bg-green-500' : 'bg-red-500'}`}
                    />
                    <div className="min-w-0">
                      <div className="font-medium truncate">{conn.name}</div>
                      <div className="text-xs text-muted-foreground">{conn.host}:{conn.port}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {currentConnection?.id !== conn.id && (
                      <button
                        onClick={() => {
                          setConnection(conn.id);
                          setShowManageDialog(false);
                        }}
                        className="text-xs px-2 py-1 border rounded hover:bg-muted"
                      >
                        Select
                      </button>
                    )}
                    <button
                      onClick={() => handleSetDefault(conn.id)}
                      className="text-xs px-2 py-1 border rounded hover:bg-muted"
                      title="Set as default"
                    >
                      ★
                    </button>
                    <button
                      onClick={() => handleDeleteConnection(conn.id)}
                      className="text-xs px-2 py-1 border border-red-500/50 text-red-500 rounded hover:bg-red-500/10"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between px-4 py-3 border-t bg-muted/30">
              <button
                onClick={() => {
                  setShowManageDialog(false);
                  setShowAddDialog(true);
                }}
                className="px-4 py-2 text-sm border rounded-md hover:bg-muted"
              >
                + Add Connection
              </button>
              <button
                onClick={() => setShowManageDialog(false)}
                className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// --- Agent Tab ---

function AgentTab({
  onClose,
  onAgentConnected,
}: {
  onClose: () => void;
  onAgentConnected: () => Promise<void>;
}) {
  const [tokens, setTokens] = useState<TokenListItem[]>([]);
  const [agents, setAgents] = useState<AgentConnectionInfo[]>([]);
  const [tokenName, setTokenName] = useState('');
  const [generatedToken, setGeneratedToken] = useState<GeneratedToken | null>(null);
  const [generating, setGenerating] = useState(false);
  const [loadingTokens, setLoadingTokens] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const prevAgentCount = useRef(0);

  useEffect(() => {
    loadData();
    const interval = setInterval(pollAgents, 5000);
    return () => clearInterval(interval);
  }, []);

  const loadData = async () => {
    setLoadingTokens(true);
    try {
      const [tokenList, agentList] = await Promise.all([
        agentTokensApi.list(),
        agentTokensApi.getConnections(),
      ]);
      setTokens(tokenList);
      setAgents(agentList);
      prevAgentCount.current = agentList.length;
    } catch {
      setError('Failed to load agent tokens');
    } finally {
      setLoadingTokens(false);
    }
  };

  const pollAgents = async () => {
    try {
      const agentList = await agentTokensApi.getConnections();
      setAgents(agentList);
      if (agentList.length > 0 && agentList.length !== prevAgentCount.current) {
        await onAgentConnected();
      }
      prevAgentCount.current = agentList.length;
    } catch {
      // Silently fail polling
    }
  };

  const handleGenerate = async () => {
    if (!tokenName.trim()) return;
    setGenerating(true);
    setError(null);
    try {
      const result = await agentTokensApi.generate(tokenName.trim());
      setGeneratedToken(result);
      setTokenName('');
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate token');
    } finally {
      setGenerating(false);
    }
  };

  const handleRevoke = async (id: string) => {
    if (!confirm('Are you sure you want to revoke this token? Connected agents using it will be disconnected.')) return;
    try {
      await agentTokensApi.revoke(id);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke token');
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const cloudHost = window.location.host;

  return (
    <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto">
      <p className="text-sm text-muted-foreground">
        Deploy an agent inside your VPC to monitor Valkey/Redis instances that aren't directly accessible.
        The agent connects outbound to BetterDB Cloud via WebSocket.
      </p>

      {/* Connected Agents */}
      {agents.length > 0 && (
        <div>
          <h3 className="text-sm font-medium mb-2">Connected Agents</h3>
          <div className="space-y-2">
            {agents.map((agent) => (
              <div key={agent.id} className="flex items-center gap-2 p-2 border rounded-md bg-green-500/5">
                <span className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{agent.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {agent.valkey.type} {agent.valkey.version}
                    {agent.valkey.cluster ? ' (cluster)' : ''}
                    {agent.valkey.tls ? ' TLS' : ''}
                  </div>
                </div>
                <span className="text-xs px-1.5 py-0.5 bg-green-500/10 text-green-600 rounded">
                  Agent
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Generate Token */}
      {!generatedToken && (
        <div>
          <h3 className="text-sm font-medium mb-2">Generate Agent Token</h3>
          <div className="flex gap-2">
            <input
              type="text"
              value={tokenName}
              onChange={(e) => setTokenName(e.target.value)}
              placeholder="Token name (e.g., production-vpc)"
              className="flex-1 px-3 py-2 border rounded-md bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              onKeyDown={(e) => e.key === 'Enter' && handleGenerate()}
            />
            <button
              onClick={handleGenerate}
              disabled={generating || !tokenName.trim()}
              className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
            >
              {generating ? 'Generating...' : 'Generate'}
            </button>
          </div>
        </div>
      )}

      {/* Show Generated Token */}
      {generatedToken && (
        <div className="border rounded-md p-3 bg-amber-500/5 border-amber-500/30">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-amber-600">Save this token - it won't be shown again</h3>
          </div>
          <div className="flex gap-2 mb-3">
            <code className="flex-1 text-xs bg-background p-2 rounded border font-mono break-all select-all">
              {generatedToken.token}
            </code>
            <button
              onClick={() => copyToClipboard(generatedToken.token)}
              className="px-3 py-1 text-xs border rounded hover:bg-muted flex-shrink-0"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>

          <h4 className="text-xs font-medium mb-1">Run the agent with Docker:</h4>
          <pre className="text-xs bg-background p-2 rounded border overflow-x-auto">
            {`docker run -d \\
  --name betterdb-agent \\
  -e VALKEY_HOST=your-valkey-host \\
  -e VALKEY_PORT=6379 \\
  -e BETTERDB_CLOUD_URL=wss://${cloudHost}/agent/ws \\
  -e BETTERDB_TOKEN=${generatedToken.token} \\
  betterdb/agent:latest`}
          </pre>

          <h4 className="text-xs font-medium mt-3 mb-1">Or run with npx:</h4>
          <pre className="text-xs bg-background p-2 rounded border overflow-x-auto">
            {`npx @betterdb/agent \\
  --valkey-host your-valkey-host \\
  --valkey-port 6379 \\
  --cloud-url wss://${cloudHost}/agent/ws \\
  --token ${generatedToken.token}`}
          </pre>

          <button
            onClick={() => setGeneratedToken(null)}
            className="mt-3 text-xs text-primary hover:underline"
          >
            I've saved the token
          </button>
        </div>
      )}

      {/* Existing Tokens */}
      {!loadingTokens && tokens.length > 0 && (
        <div>
          <h3 className="text-sm font-medium mb-2">Existing Tokens</h3>
          <div className="space-y-1">
            {tokens.map((token) => {
              const isActive = !token.revokedAt && token.expiresAt > Date.now();
              return (
                <div
                  key={token.id}
                  className="flex items-center justify-between p-2 border rounded-md text-sm"
                >
                  <div className="min-w-0">
                    <div className="font-medium truncate">{token.name}</div>
                    <div className="text-xs text-muted-foreground">
                      Created {new Date(token.createdAt).toLocaleDateString()}
                      {token.lastUsedAt && ` · Last used ${new Date(token.lastUsedAt).toLocaleDateString()}`}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {token.revokedAt ? (
                      <span className="text-xs px-1.5 py-0.5 bg-red-500/10 text-red-500 rounded">
                        Revoked
                      </span>
                    ) : !isActive ? (
                      <span className="text-xs px-1.5 py-0.5 bg-yellow-500/10 text-yellow-600 rounded">
                        Expired
                      </span>
                    ) : (
                      <>
                        <span className="text-xs px-1.5 py-0.5 bg-green-500/10 text-green-600 rounded">
                          Active
                        </span>
                        <button
                          onClick={() => handleRevoke(token.id)}
                          className="text-xs px-2 py-1 border border-red-500/50 text-red-500 rounded hover:bg-red-500/10"
                        >
                          Revoke
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {loadingTokens && (
        <div className="text-sm text-muted-foreground">Loading tokens...</div>
      )}

      {error && (
        <div className="p-3 rounded-md text-sm bg-red-500/10 text-red-500">
          {error}
        </div>
      )}

      <div className="flex justify-end pt-2 border-t">
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm border rounded-md hover:bg-muted"
        >
          Close
        </button>
      </div>
    </div>
  );
}
