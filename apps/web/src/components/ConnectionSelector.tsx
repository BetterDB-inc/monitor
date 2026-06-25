import { useState, useEffect, useRef } from 'react';
import { useIsDemo } from '../contexts/DemoContext';
import { useConnection } from '../hooks/useConnection';
import { fetchApi } from '../api/client';
import { agentTokensApi, GeneratedToken, TokenListItem } from '../api/agent-tokens';
import { databasesApi, Database, DatabaseStatus, DatabaseCredentials } from '../api/databases';
import { workspaceApi } from '../api/workspace';
import type { Connection } from '../hooks/useConnection';
import type { AgentConnectionInfo } from '@betterdb/shared';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';

interface ConnectionFormData {
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  dbIndex: number;
  tls: boolean;
}

function isLocalhostHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return (
    h === 'localhost' ||
    h === '::1' ||
    h === '0.0.0.0' ||
    /^127\./.test(h)
  );
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

type AddTab = 'direct' | 'agent' | 'valkey';

export function ConnectionSelector({ isCloudMode }: { isCloudMode?: boolean }) {
  const emptyFormData = isCloudMode ? { ...defaultFormData, host: '' } : defaultFormData;
  const isDemo = useIsDemo();
  const { currentConnection, connections, loading, error, setConnection, refreshConnections } = useConnection();
  const [showAddDialog, setShowAddDialog] = useState(false);

  useEffect(() => {
    const handler = () => setShowAddDialog(true);
    window.addEventListener('betterdb:open-add-connection', handler);
    return () => window.removeEventListener('betterdb:open-add-connection', handler);
  }, []);
  const [showManageDialog, setShowManageDialog] = useState(false);
  const [formData, setFormData] = useState<ConnectionFormData>(emptyFormData);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [addTab, setAddTab] = useState<AddTab>('direct');

  const handleInputChange = (field: keyof ConnectionFormData, value: string | number | boolean) => {
    if (field === 'host' && typeof value === 'string') {
      value = value.replace(/^https?:\/\//, '').replace(/\/$/, '');
    }
    setFormData(prev => ({ ...prev, [field]: value }));
    setTestResult(null);
  };

  const handleTestConnection = async () => {
    if (isCloudMode && isLocalhostHost(formData.host)) {
      setTestResult({ success: false, message: 'localhost is not reachable from the cloud. Please provide a publicly accessible host.' });
      return;
    }
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
    if (isCloudMode && isLocalhostHost(formData.host)) {
      setTestResult({ success: false, message: 'localhost is not reachable from the cloud. Please provide a publicly accessible host.' });
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
      setFormData(emptyFormData);
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
        <div className="text-sm text-destructive mb-2">{error}</div>
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
              onClick={() => !isDemo && setShowAddDialog(true)}
              disabled={isDemo}
              data-tooltip-id="license-tooltip"
              data-tooltip-content={isDemo ? 'Not available in demo mode' : undefined}
              className={`w-7 h-7 flex items-center justify-center rounded-md text-base font-medium transition-colors ${
                isDemo
                  ? 'opacity-30 cursor-not-allowed text-primary'
                  : 'text-primary hover:bg-primary/10'
              }`}
              title={isDemo ? undefined : 'Add connection'}
            >
              +
            </button>
            {connections.length > 0 && (
              <button
                onClick={() => !isDemo && setShowManageDialog(true)}
                disabled={isDemo}
                data-tooltip-id="license-tooltip"
                data-tooltip-content={isDemo ? 'Not available in demo mode' : undefined}
                className={`w-7 h-7 flex items-center justify-center rounded-md text-base transition-colors ${
                  isDemo
                    ? 'opacity-30 cursor-not-allowed text-muted-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                }`}
                title={isDemo ? undefined : 'Manage connections'}
              >
                ⚙
              </button>
            )}
          </div>
        </div>

        {connections.length === 0 ? (
          isDemo ? (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">Demo workspace</div>
          ) : (
            <button
              onClick={() => setShowAddDialog(true)}
              className="w-full px-2 py-1.5 text-sm border border-dashed rounded-md hover:border-primary hover:text-primary transition-colors"
            >
              + Add your first connection
            </button>
          )
        ) : connections.length === 1 ? (
          <div className="flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full flex-shrink-0 ${connections[0].isConnected ? 'bg-green-500' : 'bg-destructive'}`}
            />
            <div className="min-w-0">
              <span className="text-sm font-medium truncate block">{connections[0].name}</span>
              <span className="text-xs text-muted-foreground">{connections[0].host}:{connections[0].port}</span>
            </div>
          </div>
        ) : (
          <Select
            value={currentConnection?.id ?? ''}
            onValueChange={(value) => setConnection(value)}
          >
            <SelectTrigger className="w-full h-auto py-1.5 text-sm">
              <SelectValue placeholder="Select connection" />
            </SelectTrigger>
            <SelectContent>
              {connections.map((conn) => (
                <SelectItem key={conn.id} value={conn.id}>
                  <span className="flex items-center gap-2">
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${conn.isConnected ? 'bg-green-500' : 'bg-destructive'}`} />
                    {conn.name} ({conn.host}:{conn.port})
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Add Connection Dialog */}
      <Dialog open={showAddDialog} onOpenChange={(open) => {
        setShowAddDialog(open);
        if (!open) {
          setFormData(emptyFormData);
          setTestResult(null);
        }
      }}>
        <DialogContent className={isCloudMode ? (addTab === 'valkey' ? 'sm:max-w-3xl' : 'sm:max-w-2xl') : 'sm:max-w-md'}>
          <DialogHeader>
            <DialogTitle>Add Connection</DialogTitle>
          </DialogHeader>

          {/* Tab switcher (only if cloud mode) */}
          {isCloudMode && (
            <div className="flex border-b">
              <button
                onClick={() => setAddTab('direct')}
                className={`flex-1 whitespace-nowrap px-4 py-2 text-sm font-medium border-b-2 transition-colors ${addTab === 'direct'
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}
              >
                Direct Connection
              </button>
              <button
                onClick={() => setAddTab('agent')}
                className={`flex-1 whitespace-nowrap px-4 py-2 text-sm font-medium border-b-2 transition-colors ${addTab === 'agent'
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}
              >
                Via Agent
              </button>
              <button
                onClick={() => setAddTab('valkey')}
                className={`flex-1 whitespace-nowrap px-4 py-2 text-sm font-medium border-b-2 transition-colors ${addTab === 'valkey'
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}
              >
                BetterDB Valkey instances
              </button>
            </div>
          )}

          {addTab === 'valkey' ? (
            <ValkeyInstancesTab
              connections={connections}
              onClose={() => {
                setShowAddDialog(false);
                setFormData(emptyFormData);
                setTestResult(null);
                setAddTab('direct');
              }}
              refreshConnections={refreshConnections}
            />
          ) : addTab === 'direct' ? (
            <>
              <div className="space-y-4">
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
                      placeholder={isCloudMode ? 'your-redis-host.example.com' : 'localhost'}
                      className={`w-full px-3 py-2 border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary ${
                        isCloudMode && isLocalhostHost(formData.host) ? 'border-amber-500 focus:ring-amber-500' : ''
                      }`}
                    />
                    {isCloudMode && isLocalhostHost(formData.host) && (
                      <div className="mt-1.5 text-xs text-amber-600 dark:text-amber-500 leading-snug space-y-1">
                        <p><strong>localhost won't work on the cloud.</strong> Please provide a publicly accessible address.</p>
                        <a
                          href="https://docs.betterdb.com/providers/"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block underline underline-offset-2 hover:text-amber-700 dark:hover:text-amber-400"
                        >
                          Provider setup guides →
                        </a>
                        <p>Want to monitor a local instance?</p>
                        <a
                          href="https://hub.docker.com/r/betterdb/monitor"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block underline underline-offset-2 hover:text-amber-700 dark:hover:text-amber-400"
                        >
                          Run BetterDB locally with Docker →
                        </a>
                      </div>
                    )}
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
                  <div className={`p-3 rounded-md text-sm ${testResult.success ? 'bg-green-500/10 text-green-500' : 'bg-destructive/10 text-destructive'}`}>
                    {testResult.message}
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between pt-3 border-t bg-muted/30 -mx-4 -mb-4 px-4 py-3 rounded-b-xl">
                <button
                  onClick={handleTestConnection}
                  disabled={testing || !formData.host || (isCloudMode && isLocalhostHost(formData.host))}
                  className="px-4 py-2 text-sm border rounded-md hover:bg-muted disabled:opacity-50"
                >
                  {testing ? 'Testing...' : 'Test Connection'}
                </button>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setShowAddDialog(false);
                      setFormData(emptyFormData);
                      setTestResult(null);
                    }}
                    className="px-4 py-2 text-sm border rounded-md hover:bg-muted"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSaveConnection}
                    disabled={saving || !formData.name || !formData.host || (isCloudMode && isLocalhostHost(formData.host))}
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
                setFormData(emptyFormData);
                setTestResult(null);
                setAddTab('direct');
              }}
              onAgentConnected={refreshConnections}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Manage Connections Dialog */}
      <Dialog open={showManageDialog} onOpenChange={setShowManageDialog}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Manage Connections</DialogTitle>
          </DialogHeader>

          <div className="space-y-2 max-h-96 overflow-y-auto">
            {connections.map((conn) => (
              <div
                key={conn.id}
                className={`flex items-center justify-between p-3 border rounded-md ${currentConnection?.id === conn.id ? 'border-primary bg-primary/5' : ''
                  }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span
                    className={`w-2 h-2 rounded-full flex-shrink-0 ${conn.isConnected ? 'bg-green-500' : 'bg-destructive'}`}
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
                    className="text-xs px-2 py-1 border border-destructive/50 text-destructive rounded hover:bg-destructive/10"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between pt-3 border-t bg-muted/30 -mx-4 -mb-4 px-4 py-3 rounded-b-xl">
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
        </DialogContent>
      </Dialog>
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
        agentTokensApi.list('agent'),
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
      const result = await agentTokensApi.generate(tokenName.trim(), 'agent');
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
    <div className="space-y-4 max-h-[70vh] overflow-y-auto">
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
                {agent.authMode === 'elasticache-iam' && (
                  <span
                    className="text-xs px-1.5 py-0.5 bg-indigo-500/10 text-indigo-600 rounded"
                    title="Agent uses AWS IAM authentication; credentials rotate automatically"
                  >
                    IAM
                  </span>
                )}
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
                      <span className="text-xs px-1.5 py-0.5 bg-destructive/10 text-destructive rounded">
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
                          className="text-xs px-2 py-1 border border-destructive/50 text-destructive rounded hover:bg-destructive/10"
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
        <div className="p-3 rounded-md text-sm bg-destructive/10 text-destructive">
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

// --- BetterDB Valkey Instances Tab ---

const MAX_VALKEY_INSTANCES = 1;
const VALKEY_NAME_MAX_LENGTH = 25;
const VALKEY_ACTIVE_STATUSES: DatabaseStatus[] = ['pending', 'provisioning', 'deleting'];

function ValkeyInstancesTab({
  connections,
  onClose,
  refreshConnections,
}: {
  connections: Connection[];
  onClose: () => void;
  refreshConnections: () => Promise<void>;
}) {
  const [databases, setDatabases] = useState<Database[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAdminOrOwner, setIsAdminOrOwner] = useState(false);
  const [name, setName] = useState('');
  const [maxmemory, setMaxmemory] = useState('768mb');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<Record<string, DatabaseCredentials>>({});
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const atCapacity = databases.length >= MAX_VALKEY_INSTANCES;

  const loadData = async () => {
    try {
      const data = await databasesApi.list();
      setDatabases(data);
    } catch (err) {
      console.error('Failed to load databases:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    workspaceApi
      .getMe()
      .then((me) => setIsAdminOrOwner(me.role === 'admin' || me.role === 'owner'))
      .catch(() => {});
  }, []);

  // Poll while any instance is still settling.
  useEffect(() => {
    const settling = databases.some((db) => VALKEY_ACTIVE_STATUSES.includes(db.status));
    if (settling && !pollRef.current) {
      pollRef.current = setInterval(loadData, 4000);
    } else if (!settling && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [databases]);

  // Ready instances are mirrored into the connection list by useValkeyAutoLink
  // (mounted app-wide in AppLayout) so linking survives this dialog closing.

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      setCreating(true);
      setError(null);
      setSuccess(null);
      await databasesApi.create({
        name: name.trim().toLowerCase(),
        maxmemory: maxmemory.trim() || undefined,
      });
      setSuccess(`Creating instance '${name.trim().toLowerCase()}'`);
      setName('');
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create instance');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (db: Database) => {
    if (!confirm(`Delete instance '${db.name}'? This permanently destroys its data.`)) return;
    try {
      setError(null);
      await databasesApi.remove(db.id);
      setSuccess(`Deleting instance '${db.name}'`);
      setCredentials((prev) => {
        const next = { ...prev };
        delete next[db.id];
        return next;
      });
      // Remove the Monitor connection(s) that were auto-added for this instance
      // so they don't linger in the dropdown after the instance is gone.
      const orphans = connections.filter((c) => c.host === db.host && c.port === db.port);
      for (const c of orphans) {
        try {
          await fetchApi(`/connections/${c.id}`, { method: 'DELETE' });
        } catch (err) {
          console.error('Failed to remove linked connection:', err);
        }
      }
      if (orphans.length > 0) await refreshConnections();
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete instance');
    }
  };

  const handleToggleConnectionString = async (db: Database) => {
    if (credentials[db.id]) {
      setCredentials((prev) => {
        const next = { ...prev };
        delete next[db.id];
        return next;
      });
      return;
    }
    try {
      setError(null);
      const creds = await databasesApi.credentials(db.id);
      setCredentials((prev) => ({ ...prev, [db.id]: creds }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load connection string');
    }
  };

  return (
    <div className="space-y-4 max-h-[70vh] overflow-y-auto">
      <p className="text-sm text-muted-foreground">
        Provision a managed Valkey instance with the Search module, reachable over TLS.
        Once ready, it's added to your connections automatically.
      </p>

      {error && (
        <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">{error}</div>
      )}
      {success && (
        <div className="p-3 rounded-md bg-green-500/10 text-green-600 text-sm">{success}</div>
      )}

      {isAdminOrOwner && !atCapacity && (
        <form onSubmit={handleCreate} className="space-y-3 border rounded-md p-3">
          <div className="flex items-end gap-3 flex-wrap">
            <div className="flex-1 min-w-[180px]">
              <label className="block text-sm font-medium mb-1">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-cache"
                required
                maxLength={VALKEY_NAME_MAX_LENGTH}
                pattern="[a-z][a-z0-9-]*[a-z0-9]"
                title="Lowercase letters, digits and hyphens; must start with a letter"
                className="w-full px-3 py-2 border rounded-md bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Max memory</label>
              <select
                value={maxmemory}
                onChange={(e) => setMaxmemory(e.target.value)}
                className="px-3 py-2 border rounded-md bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="256mb">256mb</option>
                <option value="768mb">768mb</option>
                <option value="2gb">2gb</option>
              </select>
            </div>
            <button
              type="submit"
              disabled={creating || !name.trim()}
              className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50"
            >
              {creating ? 'Creating...' : 'Create'}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            The name becomes the public hostname, so it must be unique and at most{' '}
            {VALKEY_NAME_MAX_LENGTH} characters. One instance per workspace for now.
          </p>
        </form>
      )}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : databases.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No instances yet. {isAdminOrOwner ? 'Create one above to get started.' : ''}
        </p>
      ) : (
        databases.map((db) => (
          <div key={db.id} className="border rounded-md p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-medium">{db.name}</span>
                <span
                  className={`text-xs px-1.5 py-0.5 rounded ${
                    db.status === 'ready'
                      ? 'bg-green-500/10 text-green-600'
                      : db.status === 'error'
                        ? 'bg-destructive/10 text-destructive'
                        : 'bg-yellow-500/10 text-yellow-600'
                  }`}
                >
                  {db.status}
                </span>
              </div>
              {isAdminOrOwner && db.status !== 'deleting' && (
                <button
                  onClick={() => handleDelete(db)}
                  className="text-xs px-2 py-1 border border-destructive/50 text-destructive rounded hover:bg-destructive/10"
                >
                  Delete
                </button>
              )}
            </div>

            {db.statusMessage && db.status === 'error' && (
              <p className="text-sm text-destructive">{db.statusMessage}</p>
            )}

            {db.status === 'ready' && db.host ? (
              <div className="space-y-2">
                <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5 text-sm">
                  <dt className="text-muted-foreground">Host</dt>
                  <dd className="font-mono break-all">{db.host}</dd>
                  <dt className="text-muted-foreground">Port</dt>
                  <dd className="font-mono">{db.port}</dd>
                  <dt className="text-muted-foreground">Username</dt>
                  <dd className="font-mono">{db.username}</dd>
                  <dt className="text-muted-foreground">TLS</dt>
                  <dd className="font-mono">required</dd>
                </dl>

                {isAdminOrOwner && (
                  <button
                    onClick={() => handleToggleConnectionString(db)}
                    className="text-sm text-primary hover:text-primary/80"
                  >
                    {credentials[db.id] ? 'Hide connection string' : 'Show connection string'}
                  </button>
                )}

                {credentials[db.id] && (
                  <div className="space-y-2 rounded-md border bg-muted/40 p-3">
                    <div>
                      <div className="text-xs text-muted-foreground mb-1">Connection URL</div>
                      <code className="block break-all font-mono text-xs">
                        rediss://{credentials[db.id].username}:{credentials[db.id].password}@
                        {credentials[db.id].host}:{credentials[db.id].port}
                      </code>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground mb-1">valkey-cli</div>
                      <code className="block break-all font-mono text-xs">
                        valkey-cli --tls --sni {credentials[db.id].host} -h{' '}
                        {credentials[db.id].host} -p {credentials[db.id].port} --user{' '}
                        {credentials[db.id].username} --pass {credentials[db.id].password}
                      </code>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {db.status === 'deleting'
                  ? 'Tearing down...'
                  : db.status === 'error'
                    ? 'Provisioning failed.'
                    : 'Provisioning, this can take a couple of minutes...'}
              </p>
            )}
          </div>
        ))
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
