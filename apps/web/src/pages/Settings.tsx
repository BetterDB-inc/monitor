import { useState, useEffect } from 'react';
import { settingsApi } from '../api/settings';
import { useConnection } from '../hooks/useConnection';
import { AppSettings, SettingsUpdateRequest } from '@betterdb/shared';
import { Card } from '../components/ui/card';
import { Badge } from '../components/ui/badge';

type SettingsCategory = 'audit' | 'clientAnalytics' | 'anomaly';

export function Settings() {
  const { currentConnection } = useConnection();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [source, setSource] = useState<'database' | 'environment' | 'defaults'>('defaults');
  const [requiresRestart, setRequiresRestart] = useState(false);
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>('audit');
  const [formData, setFormData] = useState<Partial<AppSettings>>({});
  const [hasChanges, setHasChanges] = useState(false);

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
        <div className="text-lg text-gray-500">Loading settings...</div>
      </div>
    );
  }

  const categories: { id: SettingsCategory; label: string }[] = [
    { id: 'audit', label: 'Audit Trail' },
    { id: 'clientAnalytics', label: 'Client Analytics' },
    { id: 'anomaly', label: 'Anomaly Detection' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Settings</h1>
          <p className="text-sm text-gray-500 mt-1">Configure application settings</p>
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
                  ? 'bg-blue-100 text-blue-900 font-medium'
                  : 'hover:bg-gray-100'
              }`}
            >
              {category.label}
            </button>
          ))}
        </aside>

        <div className="flex-1">
          <Card className="p-6">
            {activeCategory === 'audit' && (
              <div className="space-y-4">
                <h2 className="text-xl font-semibold mb-4">Audit Trail</h2>
                <p className="text-sm text-gray-500">
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
                <p className="text-sm text-gray-500">
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
                <p className="text-sm text-gray-500">
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

            <div className="flex items-center gap-3 mt-6 pt-6 border-t">
              <button
                onClick={handleSave}
                disabled={!hasChanges || saving}
                className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
              >
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
              <button
                onClick={handleCancel}
                disabled={!hasChanges || saving}
                className="px-4 py-2 border rounded-md hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
              <button
                onClick={handleReset}
                disabled={saving}
                className="ml-auto px-4 py-2 text-red-600 border border-red-600 rounded-md hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Reset to Defaults
              </button>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
