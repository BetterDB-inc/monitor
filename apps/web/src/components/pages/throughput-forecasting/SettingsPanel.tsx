import type { ThroughputSettings, ThroughputSettingsUpdate } from '@betterdb/shared';
import { Card } from '../../ui/card.tsx';
import { ALERT_PRESETS, WINDOW_PRESETS } from './utils.ts';

export function SettingsPanel({
  settings,
  onUpdate,
  saveStatus,
}: {
  settings: ThroughputSettings;
  onUpdate: (u: ThroughputSettingsUpdate) => void;
  saveStatus: 'idle' | 'saved' | 'error';
}) {
  return (
    <Card className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Settings</h2>
        <div className="flex items-center gap-2">
          {saveStatus === 'saved' && <span className="text-sm text-green-600">Saved</span>}
          {saveStatus === 'error' && <span className="text-sm text-red-600">Error saving</span>}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <label className="block text-sm font-medium mb-1">Rolling Window</label>
          <select
            value={settings.rollingWindowMs}
            onChange={(e) => onUpdate({ rollingWindowMs: parseInt(e.target.value) })}
            className="w-full px-3 py-2 border rounded-md"
          >
            {WINDOW_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Ops/sec Ceiling</label>
          <input
            type="number"
            value={settings.opsCeiling ?? ''}
            placeholder="No ceiling"
            onChange={(e) =>
              onUpdate({ opsCeiling: e.target.value ? parseInt(e.target.value) : null })
            }
            className="w-full px-3 py-2 border rounded-md"
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">
            Alert Threshold <span className="text-xs text-muted-foreground">(Pro)</span>
          </label>
          <select
            value={settings.alertThresholdMs}
            onChange={(e) => onUpdate({ alertThresholdMs: parseInt(e.target.value) })}
            className="w-full px-3 py-2 border rounded-md"
            disabled={settings.opsCeiling === null}
          >
            {ALERT_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </Card>
  );
}
