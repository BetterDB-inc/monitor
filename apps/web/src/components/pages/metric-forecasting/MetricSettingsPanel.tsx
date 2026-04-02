import type { MetricForecastSettings, MetricForecastSettingsUpdate, MetricKindMeta } from '@betterdb/shared';
import { Card } from '../../ui/card';
import { Switch } from '../../ui/switch';

const WINDOW_PRESETS = [
  { label: '1h', value: 3600000 },
  { label: '3h', value: 10800000 },
  { label: '6h', value: 21600000 },
  { label: '12h', value: 43200000 },
  { label: '24h', value: 86400000 },
];

const ALERT_PRESETS = [
  { label: '30m', value: 1800000 },
  { label: '1h', value: 3600000 },
  { label: '2h', value: 7200000 },
  { label: '4h', value: 14400000 },
];

export function MetricSettingsPanel({
  settings,
  meta,
  onUpdate,
  saveStatus,
}: {
  settings: MetricForecastSettings;
  meta: MetricKindMeta;
  onUpdate: (u: MetricForecastSettingsUpdate) => void;
  saveStatus: 'idle' | 'saved' | 'error';
}) {
  return (
    <Card className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Instance Settings</h2>
        <div className="flex items-center gap-2">
          {saveStatus === 'saved' && <span className="text-sm text-green-600">Saved</span>}
          {saveStatus === 'error' && <span className="text-sm text-destructive">Error saving</span>}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="flex items-center gap-3">
          <label className="block text-sm font-medium">Enabled</label>
          <Switch
            checked={settings.enabled}
            onCheckedChange={(checked) => onUpdate({ enabled: checked })}
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Rolling Window</label>
          <select
            value={settings.rollingWindowMs}
            onChange={(e) => onUpdate({ rollingWindowMs: parseInt(e.target.value, 10) })}
            className="w-full px-3 py-2 border rounded-md"
          >
            {WINDOW_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">{meta.ceilingLabel}</label>
          <input
            type="number"
            step={meta.valueFormatter === 'ratio' ? '0.1' : '1'}
            value={settings.ceiling ?? ''}
            placeholder={meta.defaultCeiling !== null ? String(meta.defaultCeiling) : 'No ceiling'}
            onChange={(e) => {
              const raw = e.target.value;
              if (!raw) {
                onUpdate({ ceiling: null });
                return;
              }
              const parsed = parseFloat(raw);
              onUpdate({ ceiling: isNaN(parsed) || parsed <= 0 ? null : parsed });
            }}
            className="w-full px-3 py-2 border rounded-md"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">
            Alert Threshold <span className="text-xs text-muted-foreground">(Pro)</span>
          </label>
          <select
            value={settings.alertThresholdMs}
            onChange={(e) => onUpdate({ alertThresholdMs: parseInt(e.target.value, 10) })}
            className="w-full px-3 py-2 border rounded-md"
            disabled={settings.ceiling === null}
          >
            {ALERT_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>
      </div>
    </Card>
  );
}
