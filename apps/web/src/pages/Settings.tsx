import { useState, useEffect } from 'react';
import { settingsApi } from '../api/settings';
import { agentTokensApi, GeneratedToken } from '../api/agent-tokens';
import { registrationApi } from '../api/registration';
import { licenseApi } from '../api/license';
import { useMcpTokens } from '../hooks/useMcpTokens';
import { useConnection } from '../hooks/useConnection';
import { useLicense } from '../hooks/useLicense';
import { AppSettings, SettingsUpdateRequest } from '@betterdb/shared';
import { Card } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { useQueryClient } from '@tanstack/react-query';
type SettingsCategory = 'license' | 'audit' | 'clientAnalytics' | 'anomaly' | 'mcpTokens';

export function Settings({ isCloudMode = false }: { isCloudMode?: boolean }) {
  const { currentConnection } = useConnection();
  const { tier, license } = useLicense();
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [source, setSource] = useState<'database' | 'environment' | 'defaults'>('defaults');
  const [requiresRestart, setRequiresRestart] = useState(false);
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>('license');
  const [formData, setFormData] = useState<Partial<AppSettings>>({});
  const [hasChanges, setHasChanges] = useState(false);

  // Registration/license state
  const [regEmail, setRegEmail] = useState('');
  const [regSubmitting, setRegSubmitting] = useState(false);
  const [regSuccess, setRegSuccess] = useState(false);
  const [regError, setRegError] = useState<string | null>(null);
  const [activateKey, setActivateKey] = useState('');
  const [activating, setActivating] = useState(false);
  const [activateError, setActivateError] = useState<string | null>(null);
  const [showChangeKey, setShowChangeKey] = useState(false);

  // MCP Tokens state (must be before any early returns)
  const { tokens: mcpTokens, invalidate: invalidateMcpTokens } = useMcpTokens(
    isCloudMode && activeCategory === 'mcpTokens',
  );
  const [mcpTokenName, setMcpTokenName] = useState('');
  const [mcpGenerating, setMcpGenerating] = useState(false);
  const [mcpGeneratedToken, setMcpGeneratedToken] = useState<GeneratedToken | null>(null);
  const [mcpCopied, setMcpCopied] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);

  useEffect(() => {
    loadSettings();
  }, [currentConnection?.id]);

  const loadSettings = async () => {
    try {
      setLoading(true);
      const response = await settingsApi.getSettings();
      setSettings(response.settings);
      setFormData(response.settings);
      setSource(response.source);
      setRequiresRestart(response.requiresRestart);
      setHasChanges(false);
    } catch (error) {
      console.error('Failed to load settings:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleInputChange = (key: keyof AppSettings, value: any) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
    setHasChanges(true);
  };

  const handleSave = async () => {
    if (!settings) return;

    try {
      setSaving(true);
      const updates: SettingsUpdateRequest = {};

      // Only include changed fields
      (Object.keys(formData) as Array<keyof AppSettings>).forEach((key) => {
        if (formData[key] !== settings[key] && key !== 'id' && key !== 'createdAt' && key !== 'updatedAt') {
          (updates as any)[key] = formData[key];
        }
      });

      const response = await settingsApi.updateSettings(updates);
      setSettings(response.settings);
      setFormData(response.settings);
      setSource(response.source);
      setRequiresRestart(response.requiresRestart);
      setHasChanges(false);
    } catch (error) {
      console.error('Failed to save settings:', error);
      alert('Failed to save settings. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    if (settings) {
      setFormData(settings);
      setHasChanges(false);
    }
  };

  const handleReset = async () => {
    if (!confirm('Are you sure you want to reset all settings to defaults? This will require a restart.')) {
      return;
    }

    try {
      setSaving(true);
      const response = await settingsApi.resetSettings();
      setSettings(response.settings);
      setFormData(response.settings);
      setSource(response.source);
      setRequiresRestart(response.requiresRestart);
      setHasChanges(false);
    } catch (error) {
      console.error('Failed to reset settings:', error);
      alert('Failed to reset settings. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-lg text-muted-foreground">Loading settings...</div>
      </div>
    );
  }

  const handleMcpGenerate = async () => {
    if (!mcpTokenName.trim()) return;
    setMcpGenerating(true);
    setMcpError(null);
    try {
      const result = await agentTokensApi.generate(mcpTokenName.trim(), 'mcp');
      setMcpGeneratedToken(result);
      setMcpTokenName('');
      await invalidateMcpTokens();
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : 'Failed to generate token');
    } finally {
      setMcpGenerating(false);
    }
  };

  const handleMcpRevoke = async (id: string) => {
    try {
      await agentTokensApi.revoke(id);
      await invalidateMcpTokens();
    } catch (err) {
      setMcpError(err instanceof Error ? err.message : 'Failed to revoke token');
    }
  };

  const copyMcpToken = (text: string) => {
    navigator.clipboard.writeText(text);
    setMcpCopied(true);
    setTimeout(() => setMcpCopied(false), 2000);
  };

  const handleRegister = async () => {
    if (!regEmail.trim()) return;
    setRegSubmitting(true);
    setRegError(null);
    try {
      await registrationApi.register(regEmail.trim());
      setRegSuccess(true);
      setRegEmail('');
    } catch (err) {
      setRegError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setRegSubmitting(false);
    }
  };

  const handleActivate = async () => {
    if (!activateKey.trim()) return;
    setActivating(true);
    setActivateError(null);
    try {
      await licenseApi.activate(activateKey.trim());
      setActivateKey('');
      // Refresh the license status so the UI updates immediately
      queryClient.invalidateQueries({ queryKey: ['license-status'] });
    } catch (err) {
      setActivateError(err instanceof Error ? err.message : 'Activation failed');
    } finally {
      setActivating(false);
    }
  };

  const categories: { id: SettingsCategory; label: string }[] = [
    { id: 'license', label: 'License' },
    { id: 'audit', label: 'Audit Trail' },
    { id: 'clientAnalytics', label: 'Client Analytics' },
    { id: 'anomaly', label: 'Anomaly Detection' },
    ...(isCloudMode ? [{ id: 'mcpTokens' as const, label: 'MCP Tokens' }] : []),
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Settings</h1>
          <p className="text-sm text-muted-foreground mt-1">Configure application settings</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">Source: {source}</Badge>
          {requiresRestart && <Badge variant="destructive">Restart Required</Badge>}
        </div>
      </div>

      <div className="flex gap-6">
        <aside className="w-64 space-y-2">
          {categories.map((category) => (
            <button
              key={category.id}
              onClick={() => setActiveCategory(category.id)}
              className={`w-full text-left px-4 py-3 rounded-lg transition-colors ${
                activeCategory === category.id
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'hover:bg-muted'
              }`}
            >
              {category.label}
            </button>
          ))}
        </aside>

        <div className="flex-1">
          <Card className="p-6">
            {activeCategory === 'license' && (
              <div className="space-y-6">
                {tier === 'community' ? (
                  <>
                    <div>
                      <h2 className="text-xl font-semibold">Unlock all features — free during early access</h2>
                      <p className="text-sm text-muted-foreground mt-1">
                        Get access to every Pro and Enterprise feature at no cost, plus product updates, priority support, and extended free access even if pricing changes.
                      </p>
                    </div>

                    {regSuccess ? (
                      <div className="bg-green-50 border border-green-200 rounded-md p-4">
                        <p className="text-sm font-medium text-green-800">Check your email for your license key</p>
                        <p className="text-xs text-green-600 mt-1">
                          Paste it below to activate.
                        </p>
                      </div>
                    ) : (
                      <div>
                        <label className="block text-sm font-medium mb-1">Email address</label>
                        <div className="flex gap-2">
                          <input
                            type="email"
                            value={regEmail}
                            onChange={(e) => setRegEmail(e.target.value)}
                            placeholder="you@company.com"
                            className="flex-1 px-3 py-2 border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                            onKeyDown={(e) => e.key === 'Enter' && handleRegister()}
                          />
                          <button
                            onClick={handleRegister}
                            disabled={regSubmitting || !regEmail.trim()}
                            className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed whitespace-nowrap"
                          >
                            {regSubmitting ? 'Sending...' : 'Get my free license key'}
                          </button>
                        </div>
                        {regError && (
                          <p className="text-sm text-destructive mt-1">{regError}</p>
                        )}
                      </div>
                    )}

                    <div className="border-t pt-4">
                      <label className="block text-sm font-medium mb-1">Already have a license key?</label>
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={activateKey}
                          onChange={(e) => setActivateKey(e.target.value)}
                          placeholder="btdb_..."
                          className="flex-1 px-3 py-2 border rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary"
                          onKeyDown={(e) => e.key === 'Enter' && handleActivate()}
                        />
                        <button
                          onClick={handleActivate}
                          disabled={activating || !activateKey.trim()}
                          className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed"
                        >
                          {activating ? 'Activating...' : 'Activate'}
                        </button>
                      </div>
                      {activateError && (
                        <p className="text-sm text-destructive mt-1">{activateError}</p>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-3">
                      <h2 className="text-xl font-semibold">License</h2>
                      <span className="text-xs px-2 py-1 bg-green-100 text-green-700 rounded-full font-medium capitalize">
                        {tier}
                      </span>
                    </div>

                    {license?.customer?.email && (
                      <div className="text-sm text-muted-foreground">
                        Registered to <span className="font-medium text-foreground">{license.customer.email}</span>
                      </div>
                    )}

                    <div className="bg-muted/50 border rounded-md p-4 text-sm">
                      Early access — all features free. You'll get advance notice before anything changes.
                    </div>

                    <div className="border-t pt-4">
                      {!showChangeKey ? (
                        <button
                          onClick={() => setShowChangeKey(true)}
                          className="text-sm text-primary hover:underline cursor-pointer"
                          type="button"
                        >
                          Change license key
                        </button>
                      ) : (
                        <>
                          <label className="block text-sm font-medium mb-1">New license key</label>
                          <div className="flex gap-2">
                            <input
                              type="text"
                              value={activateKey}
                              onChange={(e) => setActivateKey(e.target.value)}
                              placeholder="btdb_..."
                              className="flex-1 px-3 py-2 border rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary"
                              onKeyDown={(e) => e.key === 'Enter' && handleActivate()}
                            />
                            <button
                              onClick={handleActivate}
                              disabled={activating || !activateKey.trim()}
                              className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed"
                            >
                              {activating ? 'Activating...' : 'Activate'}
                            </button>
                            <button
                              onClick={() => { setShowChangeKey(false); setActivateKey(''); setActivateError(null); }}
                              className="px-3 py-2 text-sm border rounded-md hover:bg-muted"
                            >
                              Cancel
                            </button>
                          </div>
                          {activateError && (
                            <p className="text-sm text-destructive mt-1">{activateError}</p>
                          )}
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}

            {activeCategory === 'audit' && (
              <div className="space-y-4">
                <h2 className="text-xl font-semibold mb-4">Audit Trail</h2>
                <p className="text-sm text-muted-foreground">
                  These settings take effect within 30 seconds without requiring a restart.
                </p>

                <div>
                  <label className="block text-sm font-medium mb-1">Poll Interval (ms)</label>
                  <input
                    type="number"
                    value={formData.auditPollIntervalMs || 60000}
                    onChange={(e) => handleInputChange('auditPollIntervalMs', parseInt(e.target.value))}
                    className="w-full px-3 py-2 border rounded-md"
                  />
                </div>
              </div>
            )}

            {activeCategory === 'clientAnalytics' && (
              <div className="space-y-4">
                <h2 className="text-xl font-semibold mb-4">Client Analytics</h2>
                <p className="text-sm text-muted-foreground">
                  These settings take effect within 30 seconds without requiring a restart.
                </p>

                <div>
                  <label className="block text-sm font-medium mb-1">Poll Interval (ms)</label>
                  <input
                    type="number"
                    value={formData.clientAnalyticsPollIntervalMs || 60000}
                    onChange={(e) => handleInputChange('clientAnalyticsPollIntervalMs', parseInt(e.target.value))}
                    className="w-full px-3 py-2 border rounded-md"
                  />
                </div>
              </div>
            )}

            {activeCategory === 'anomaly' && (
              <div className="space-y-4">
                <h2 className="text-xl font-semibold mb-4">Anomaly Detection</h2>
                <p className="text-sm text-muted-foreground">
                  These settings take effect within 30 seconds without requiring a restart.
                </p>

                <div>
                  <label className="block text-sm font-medium mb-1">Poll Interval (ms)</label>
                  <input
                    type="number"
                    value={formData.anomalyPollIntervalMs || 1000}
                    onChange={(e) => handleInputChange('anomalyPollIntervalMs', parseInt(e.target.value))}
                    className="w-full px-3 py-2 border rounded-md"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">Cache TTL (ms)</label>
                  <input
                    type="number"
                    value={formData.anomalyCacheTtlMs || 3600000}
                    onChange={(e) => handleInputChange('anomalyCacheTtlMs', parseInt(e.target.value))}
                    className="w-full px-3 py-2 border rounded-md"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium mb-1">Prometheus Export Interval (ms)</label>
                  <input
                    type="number"
                    value={formData.anomalyPrometheusIntervalMs || 30000}
                    onChange={(e) => handleInputChange('anomalyPrometheusIntervalMs', parseInt(e.target.value))}
                    className="w-full px-3 py-2 border rounded-md"
                  />
                </div>
              </div>
            )}

            {activeCategory === 'mcpTokens' && (
              <div className="space-y-4">
                <h2 className="text-xl font-semibold mb-4">MCP Tokens</h2>
                <p className="text-sm text-muted-foreground">
                  Generate tokens for MCP (Model Context Protocol) clients like Claude Code to access your database observability data.
                </p>

                {mcpError && (
                  <div className="text-sm text-destructive bg-destructive/5 border border-destructive/20 rounded-md p-2">
                    {mcpError}
                  </div>
                )}

                {/* Generate Token */}
                {!mcpGeneratedToken && (
                  <div>
                    <label className="block text-sm font-medium mb-1">Generate MCP Token</label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={mcpTokenName}
                        onChange={(e) => setMcpTokenName(e.target.value)}
                        placeholder="Token name (e.g., claude-code)"
                        className="flex-1 px-3 py-2 border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                        onKeyDown={(e) => e.key === 'Enter' && handleMcpGenerate()}
                      />
                      <button
                        onClick={handleMcpGenerate}
                        disabled={mcpGenerating || !mcpTokenName.trim()}
                        className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed"
                      >
                        {mcpGenerating ? 'Generating...' : 'Generate'}
                      </button>
                    </div>
                  </div>
                )}

                {/* Show Generated Token */}
                {mcpGeneratedToken && (
                  <div className="border rounded-md p-3 bg-amber-50 border-amber-300">
                    <h3 className="text-sm font-medium text-amber-700 mb-2">
                      Save this token - it won't be shown again
                    </h3>
                    <div className="flex gap-2 mb-3">
                      <code className="flex-1 text-xs bg-white p-2 rounded border font-mono break-all select-all">
                        {mcpGeneratedToken.token}
                      </code>
                      <button
                        onClick={() => copyMcpToken(mcpGeneratedToken.token)}
                        className="px-3 py-1 text-xs border rounded hover:bg-muted flex-shrink-0"
                      >
                        {mcpCopied ? 'Copied!' : 'Copy'}
                      </button>
                    </div>

                    <h4 className="text-xs font-medium mb-1">Add to your Claude Code MCP config:</h4>
                    <pre className="text-xs bg-white p-2 rounded border overflow-x-auto">
{`{
  "mcpServers": {
    "betterdb": {
      "type": "stdio",
      "command": "npx",
      "args": ["@betterdb/mcp"],
      "env": {
        "BETTERDB_URL": "${window.location.origin}",
        "BETTERDB_TOKEN": "${mcpGeneratedToken.token}"
      }
    }
  }
}`}
                    </pre>

                    <button
                      onClick={() => setMcpGeneratedToken(null)}
                      className="mt-3 text-xs text-primary hover:underline"
                    >
                      I've saved the token
                    </button>
                  </div>
                )}

                {/* Existing Tokens */}
                {mcpTokens.length > 0 && (
                  <div>
                    <h3 className="text-sm font-medium mb-2">Existing Tokens</h3>
                    <div className="space-y-1">
                      {mcpTokens.map((token) => {
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
                                <span className="text-xs px-1.5 py-0.5 bg-yellow-100 text-yellow-700 rounded">
                                  Expired
                                </span>
                              ) : (
                                <>
                                  <span className="text-xs px-1.5 py-0.5 bg-green-100 text-green-700 rounded">
                                    Active
                                  </span>
                                  <button
                                    onClick={() => handleMcpRevoke(token.id)}
                                    className="text-xs px-2 py-1 border border-destructive/20 text-destructive rounded hover:bg-destructive/10"
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
              </div>
            )}

            {activeCategory !== 'mcpTokens' && activeCategory !== 'license' && (
              <div className="flex items-center gap-3 mt-6 pt-6 border-t">
                <button
                  onClick={handleSave}
                  disabled={!hasChanges || saving}
                  className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed"
                >
                  {saving ? 'Saving...' : 'Save Changes'}
                </button>
                <button
                  onClick={handleCancel}
                  disabled={!hasChanges || saving}
                  className="px-4 py-2 border rounded-md hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Cancel
                </button>
                <button
                  onClick={handleReset}
                  disabled={saving}
                  className="ml-auto px-4 py-2 text-destructive border border-destructive rounded-md hover:bg-destructive/10 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Reset to Defaults
                </button>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
