import { useState, useEffect } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { settingsApi } from '../api/settings';
import { licenseApi } from '../api/license';
import { useConnection } from '../hooks/useConnection';
import { useLicense } from '../hooks/useLicense';
import { useAuth } from '../contexts/AuthContext';
import { useDemoState } from '../contexts/DemoContext';
import { useCanMutate } from '../hooks/useCanMutate';
import { McpTokensPanel } from '../components/pages/settings/McpTokensPanel';
import { Members } from './Members';
import {
  AppSettings,
  SettingsUpdateRequest,
  MAX_RETENTION_DAYS,
  normalizeRetentionDays,
} from '@betterdb/shared';
import { Card } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { useQueryClient } from '@tanstack/react-query';
type SettingsCategory =
  | 'team'
  | 'mcpTokens'
  | 'license'
  | 'audit'
  | 'clientAnalytics'
  | 'anomaly'
  | 'dataRetention';

interface CategoryEntry {
  id: SettingsCategory;
  section: string;
  label: string;
  adminOnly: boolean;
}

const ACCOUNT_CATEGORY_IDS: ReadonlySet<SettingsCategory> = new Set(['team', 'mcpTokens']);

const RETENTION_INPUT_ERROR = `Enter a whole number of days between 1 and ${MAX_RETENTION_DAYS}, or leave empty to keep history forever.`;

function isUpdatableSettingsKey(
  key: keyof AppSettings,
): key is keyof AppSettings & keyof SettingsUpdateRequest {
  return key !== 'id' && key !== 'createdAt' && key !== 'updatedAt';
}

function copySettingsKey<K extends keyof AppSettings & keyof SettingsUpdateRequest>(
  updates: SettingsUpdateRequest,
  formData: Partial<AppSettings>,
  key: K,
): void {
  updates[key] = formData[key];
}

// The single definition of "what the user has changed": the editable keys whose
// draft value differs from what's saved. Both the Save gate (hasChanges) and the
// update payload derive from this, so a draft that collapses back to the stored
// value (e.g. type 30, then clear it) can never leave Save enabled or PUT {}.
function changedKeys(
  form: Partial<AppSettings>,
  saved: AppSettings | null,
): Array<keyof AppSettings & keyof SettingsUpdateRequest> {
  if (!saved) return [];
  return (Object.keys(form) as Array<keyof AppSettings>).filter(
    (key): key is keyof AppSettings & keyof SettingsUpdateRequest =>
      isUpdatableSettingsKey(key) && form[key] !== saved[key],
  );
}

export function Settings({ isCloudMode = false }: { isCloudMode?: boolean }) {
  const { isDemo, loading: demoLoading } = useDemoState();
  const isAdmin = useCanMutate() !== false;
  const [searchParams, setSearchParams] = useSearchParams();
  const { currentConnection } = useConnection();
  const { tier, license } = useLicense();
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(isAdmin);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [source, setSource] = useState<'database' | 'environment' | 'defaults'>('defaults');
  const [requiresRestart, setRequiresRestart] = useState(false);
  const [formData, setFormData] = useState<Partial<AppSettings>>({});
  // Derived, never stored: recomputed from (formData, settings) every render so
  // it can't fall out of sync with the draft the way a manual boolean did.
  const hasChanges = changedKeys(formData, settings).length > 0;

  // Raw text of the retention input so invalid entries stay visible with an
  // error instead of silently collapsing to "keep forever".
  const [retentionInput, setRetentionInput] = useState('');
  const [retentionError, setRetentionError] = useState<string | null>(null);

  // Single sync point for the retention draft: every path that commits or
  // reloads settings resets the input to the stored value and clears any
  // pending error, so the pair can never drift between call sites.
  const syncRetentionFrom = (days: number | null | undefined) => {
    setRetentionInput(days != null ? String(days) : '');
    setRetentionError(null);
  };

  // License state
  const [activateKey, setActivateKey] = useState('');
  const [activating, setActivating] = useState(false);
  const [activateError, setActivateError] = useState<string | null>(null);
  const [showChangeKey, setShowChangeKey] = useState(false);

  // Offline (air-gapped) license state
  const [offlineToken, setOfflineToken] = useState('');
  const [offlineActivating, setOfflineActivating] = useState(false);
  const [offlineError, setOfflineError] = useState<string | null>(null);
  const [offlineNotice, setOfflineNotice] = useState<string | null>(null);
  const [showOffline, setShowOffline] = useState(false);

  const { mode } = useAuth();
  const showAccountSections = isCloudMode === true || mode === 'self-hosted';

  const allCategories: CategoryEntry[] = [
    { id: 'team', section: 'team', label: 'Team', adminOnly: false },
    { id: 'mcpTokens', section: 'mcp-tokens', label: 'MCP Tokens', adminOnly: false },
    { id: 'license', section: 'license', label: 'License', adminOnly: true },
    { id: 'audit', section: 'audit', label: 'Audit Trail', adminOnly: true },
    { id: 'clientAnalytics', section: 'client-analytics', label: 'Client Analytics', adminOnly: true },
    { id: 'anomaly', section: 'anomaly', label: 'Anomaly Detection', adminOnly: true },
    { id: 'dataRetention', section: 'data-retention', label: 'Data Retention', adminOnly: true },
  ];
  const categories = allCategories.filter((category) => {
    if (ACCOUNT_CATEGORY_IDS.has(category.id)) {
      return showAccountSections;
    }
    return category.id !== 'dataRetention' || !isCloudMode;
  });
  const availableCategories = categories.filter((category) => isAdmin || !category.adminOnly);
  const requestedCategory = availableCategories.find(
    (category) => category.section === searchParams.get('section'),
  );
  const activeCategory = (requestedCategory ?? availableCategories[0])?.id;

  useEffect(() => {
    if (isAdmin) {
      loadSettings();
    }
  }, [currentConnection?.id, isAdmin]);

  const loadSettings = async () => {
    try {
      setLoading(true);
      const response = await settingsApi.getSettings();
      setSettings(response.settings);
      setFormData(response.settings);
      setSource(response.source);
      setRequiresRestart(response.requiresRestart);
      syncRetentionFrom(response.settings.localRetentionDays);
    } catch (error) {
      console.error('Failed to load settings:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleInputChange = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    if (!settings) return;

    try {
      setSaving(true);
      const updates: SettingsUpdateRequest = {};
      changedKeys(formData, settings).forEach((key) => {
        copySettingsKey(updates, formData, key);
      });

      const response = await settingsApi.updateSettings(updates);
      setSettings(response.settings);
      setFormData(response.settings);
      setSource(response.source);
      setRequiresRestart(response.requiresRestart);
      syncRetentionFrom(response.settings.localRetentionDays);
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
      syncRetentionFrom(settings.localRetentionDays);
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
      syncRetentionFrom(response.settings.localRetentionDays);
    } catch (error) {
      console.error('Failed to reset settings:', error);
      alert('Failed to reset settings. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  if (demoLoading === true) {
    return null;
  }

  if (isDemo === true) {
    return <Navigate to="/" replace />;
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-lg text-muted-foreground">Loading settings...</div>
      </div>
    );
  }

  const handleActivate = async () => {
    if (!activateKey.trim()) return;
    setActivating(true);
    setActivateError(null);
    try {
      await licenseApi.activate(activateKey.trim());
      setActivateKey('');
      setShowChangeKey(false);
      // Refresh the license status so the UI updates immediately
      queryClient.invalidateQueries({ queryKey: ['license-status'] });
    } catch (err) {
      setActivateError(err instanceof Error ? err.message : 'Activation failed');
    } finally {
      setActivating(false);
    }
  };

  const handleActivateOffline = async () => {
    if (!offlineToken.trim()) return;
    setOfflineActivating(true);
    setOfflineError(null);
    setOfflineNotice(null);
    try {
      const result = await licenseApi.activateOffline(offlineToken.trim());
      setOfflineToken('');
      setShowOffline(false);
      if (result.fallbackOnly && result.message) {
        setOfflineNotice(result.message);
      }
      queryClient.invalidateQueries({ queryKey: ['license-status'] });
    } catch (err) {
      setOfflineError(err instanceof Error ? err.message : 'Offline activation failed');
    } finally {
      setOfflineActivating(false);
    }
  };

  const handleOfflineFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setOfflineToken(String(reader.result || '').trim());
    reader.readAsText(file);
    e.target.value = '';
  };

  const isOfflineLicense = license?.source === 'offline-token';
  const offlineDaysLeft = license?.offlineExpiresAt
    ? Math.ceil((new Date(license.offlineExpiresAt).getTime() - Date.now()) / 86400000)
    : null;

  const offlineActivationForm = (
    <div className="border-t pt-4">
      {!showOffline ? (
        <>
          <button
            onClick={() => setShowOffline(true)}
            className="text-sm text-primary hover:underline cursor-pointer"
            type="button"
          >
            {isOfflineLicense ? 'Replace offline license' : 'Air-gapped environment? Activate an offline license'}
          </button>
          {offlineNotice && (
            <p className="text-sm text-muted-foreground mt-2">{offlineNotice}</p>
          )}
        </>
      ) : (
        <>
          <label className="block text-sm font-medium mb-1">Offline license token</label>
          <p className="text-xs text-muted-foreground mb-2">
            Download it from betterdb.com &rarr; Account &rarr; Licenses, then paste it here or upload the
            .jwt file. Verified locally &mdash; works with zero network access.
          </p>
          <textarea
            value={offlineToken}
            onChange={(e) => setOfflineToken(e.target.value)}
            placeholder="eyJhbGciOiJSUzI1NiIs..."
            rows={3}
            className="w-full px-3 py-2 border rounded-md text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary"
          />
          <div className="flex gap-2 mt-2">
            <button
              onClick={handleActivateOffline}
              disabled={offlineActivating || !offlineToken.trim()}
              className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed"
            >
              {offlineActivating ? 'Activating...' : 'Activate offline license'}
            </button>
            <label className="px-3 py-2 text-sm border rounded-md hover:bg-muted cursor-pointer">
              Upload file
              <input type="file" accept=".jwt,.txt,text/plain" className="hidden" onChange={handleOfflineFile} />
            </label>
            <button
              onClick={() => { setShowOffline(false); setOfflineToken(''); setOfflineError(null); }}
              className="px-3 py-2 text-sm border rounded-md hover:bg-muted"
            >
              Cancel
            </button>
          </div>
          {offlineError && <p className="text-sm text-destructive mt-1">{offlineError}</p>}
        </>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Settings</h1>
          <p className="text-sm text-muted-foreground mt-1">Configure application settings</p>
        </div>
        {isAdmin && (
          <div className="flex items-center gap-2">
            <Badge variant="secondary">Source: {source}</Badge>
            {requiresRestart && <Badge variant="destructive">Restart Required</Badge>}
          </div>
        )}
      </div>

      <div className="flex gap-6">
        <aside className="w-64 space-y-2">
          {categories.map((category) => {
            if (category.adminOnly && !isAdmin) {
              return (
                <span
                  key={category.id}
                  aria-disabled="true"
                  data-tooltip-id="license-tooltip"
                  data-tooltip-content="Admins only"
                  className="flex w-full items-center justify-between px-4 py-3 rounded-lg opacity-40 cursor-not-allowed select-none"
                >
                  {category.label}
                  <Lock aria-hidden="true" className="size-3.5" />
                </span>
              );
            }
            return (
              <button
                key={category.id}
                type="button"
                aria-current={activeCategory === category.id ? 'page' : undefined}
                onClick={() => {
                  setSearchParams({ section: category.section }, { replace: true });
                  // A pending invalid retention entry gates the shared Save
                  // button but its message only renders inside the Data
                  // Retention tab — leaving the tab discards the invalid text
                  // (formData was never updated with it) so other tabs aren't
                  // blocked by an error they can't see.
                  if (category.id !== 'dataRetention' && retentionError) {
                    // Discard the WHOLE draft, including any valid prefix that
                    // was committed to formData while typing (e.g. "3" en route
                    // to "3650") — reverting only the visible input would let a
                    // hidden partial value ride along with a save made from
                    // another tab and silently shrink the retention window.
                    setFormData((prev) => ({
                      ...prev,
                      localRetentionDays: settings?.localRetentionDays ?? null,
                    }));
                    syncRetentionFrom(settings?.localRetentionDays);
                  }
                }}
                className={`w-full text-left px-4 py-3 rounded-lg transition-colors ${
                  activeCategory === category.id
                    ? 'bg-primary/10 text-primary font-medium'
                    : 'hover:bg-muted'
                }`}
              >
                {category.label}
              </button>
            );
          })}
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

                    {isCloudMode ? (
                      <div className="bg-muted/50 border rounded-md p-4">
                        <p className="text-sm">Your license is managed through your workspace account.</p>
                        <p className="text-xs text-muted-foreground mt-1">
                          If your features aren't active, contact your workspace administrator or reach out to support.
                        </p>
                      </div>
                    ) : (
                      <>
                        <div className="bg-muted/50 border rounded-md p-4">
                          <p className="text-sm">
                            Licenses are managed at{' '}
                            <a
                              href="https://www.betterdb.com/account/licenses"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-primary font-medium hover:underline"
                            >
                              betterdb.com/account/licenses
                            </a>
                            . Sign in there to get your free license key, then paste it below —
                            or download an offline license for air-gapped environments.
                          </p>
                        </div>

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

                        {offlineActivationForm}
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-3">
                      <h2 className="text-xl font-semibold">License</h2>
                      <span className="text-xs px-2 py-1 bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300 rounded-full font-medium capitalize">
                        {tier}
                      </span>
                    </div>

                    {license?.customer?.email && (
                      <div className="text-sm text-muted-foreground">
                        Registered to <span className="font-medium text-foreground">{license.customer.email}</span>
                      </div>
                    )}

                    {isOfflineLicense ? (
                      <div className="bg-muted/50 border rounded-md p-4 text-sm space-y-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xs px-2 py-0.5 bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 rounded-full font-medium">
                            Offline license
                          </span>
                          {license?.instanceLimit != null && (
                            <span className="text-xs text-muted-foreground">
                              Floating &mdash; up to {license.instanceLimit} instances
                            </span>
                          )}
                        </div>
                        {license?.offlineExpiresAt && offlineDaysLeft != null && (
                          <p
                            className={
                              offlineDaysLeft <= 7
                                ? 'text-destructive font-medium'
                                : offlineDaysLeft <= 30
                                  ? 'text-amber-600 dark:text-amber-400'
                                  : 'text-muted-foreground'
                            }
                          >
                            Expires {new Date(license.offlineExpiresAt).toLocaleDateString()} ({offlineDaysLeft} days left)
                            {offlineDaysLeft <= 30 && ' — download a fresh token from your account page'}
                          </p>
                        )}
                        <p className="text-xs text-muted-foreground">
                          {license?.airGapped
                            ? 'Telemetry and phone-home are disabled while running from an offline license.'
                            : 'Offline license in use as fallback — a license key is configured, so online validation and telemetry remain active.'}
                        </p>
                      </div>
                    ) : (
                      <div className="bg-muted/50 border rounded-md p-4 text-sm">
                        Early access — all features free. You'll get advance notice before anything changes.
                      </div>
                    )}

                    {license?.clockRollbackSuspected && (
                      <div className="bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-md p-3 text-sm text-amber-800 dark:text-amber-200">
                        The system clock appears to have moved backwards — license expiry checks may be unreliable.
                      </div>
                    )}

                    {!isCloudMode && (
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
                    )}

                    {!isCloudMode && offlineActivationForm}
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

            {activeCategory === 'dataRetention' && (
              <div className="space-y-4">
                <h2 className="text-xl font-semibold mb-4">Data Retention</h2>
                <p className="text-sm text-muted-foreground">
                  Stored monitoring history is kept indefinitely by default. Set a retention window
                  to have a daily sweep delete rows older than that many days from every store: slow
                  log and command log entries, client/latency/memory snapshots, latency histograms,
                  anomaly events and correlated groups, <strong>ACL audit entries</strong>, key
                  pattern snapshots and hot keys, webhook deliveries, monitor captures, AI cache
                  samples, OTel spans, command/latency stats samples, and vector index snapshots.
                </p>

                <div>
                  <label className="block text-sm font-medium mb-1">Retention window (days)</label>
                  <input
                    type="number"
                    min={1}
                    max={MAX_RETENTION_DAYS}
                    step={1}
                    value={retentionInput}
                    placeholder="Keep forever"
                    onChange={(e) => {
                      const raw = e.target.value;
                      setRetentionInput(raw);
                      // Number inputs report invalid text (e.g. "30e") as an
                      // empty value with validity.badInput set — that is NOT
                      // the user clearing the field, so keep the error state
                      // instead of committing "keep forever".
                      if (e.currentTarget.validity.badInput) {
                        setRetentionError(RETENTION_INPUT_ERROR);
                        return;
                      }
                      if (raw.trim() === '') {
                        setRetentionError(null);
                        handleInputChange('localRetentionDays', null);
                        return;
                      }
                      // valueAsNumber understands everything a number input
                      // accepts (e.g. "1e2" is 100, not parseInt's 1). Whole
                      // numbers only — flooring "1.5" would delete history
                      // earlier than the user asked for.
                      const parsed = normalizeRetentionDays(e.currentTarget.valueAsNumber);
                      if (parsed !== null) {
                        setRetentionError(null);
                        handleInputChange('localRetentionDays', parsed);
                      } else {
                        setRetentionError(RETENTION_INPUT_ERROR);
                      }
                    }}
                    className="w-full px-3 py-2 border rounded-md"
                  />
                  {retentionError && (
                    <p className="text-sm text-destructive mt-1">{retentionError}</p>
                  )}
                  <p className="text-xs text-muted-foreground mt-1">
                    Leave empty to keep history indefinitely. On a fresh install the{' '}
                    <code className="font-mono">LOCAL_RETENTION_DAYS</code> environment variable
                    seeds this value; afterwards this page owns it. High-volume stat samples
                    (command/latency stats, vector index snapshots, AI samples, OTel spans) are additionally
                    trimmed to this window on an hourly cycle.
                  </p>
                </div>
              </div>
            )}

            {activeCategory === 'team' && <Members />}

            {activeCategory === 'mcpTokens' && <McpTokensPanel />}

            {activeCategory !== undefined &&
              !ACCOUNT_CATEGORY_IDS.has(activeCategory) &&
              activeCategory !== 'license' && (
              <div className="flex items-center gap-3 mt-6 pt-6 border-t">
                <button
                  onClick={handleSave}
                  disabled={!hasChanges || saving || retentionError !== null}
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
