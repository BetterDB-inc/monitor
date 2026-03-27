import { Card } from '../../ui/card.tsx';
import { SettingsPanel } from './SettingsPanel.tsx';
import { ThroughputSettings, ThroughputSettingsUpdate } from '@betterdb/shared';

export const Disabled = ({
  updateSetting,
  settings,
  saveStatus,
}: {
  updateSetting: (updates: ThroughputSettingsUpdate) => void;
  settings: ThroughputSettings;
  saveStatus: 'idle' | 'saved' | 'error';
}) => {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Throughput Forecast</h1>
      <Card className="p-6">
        <div className="flex items-center justify-between">
          <p className="text-muted-foreground">
            Throughput forecasting is disabled for this connection.
          </p>
          <button
            onClick={() => updateSetting({ enabled: true })}
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
          >
            Enable
          </button>
        </div>
      </Card>
      <SettingsPanel settings={settings} onUpdate={updateSetting} saveStatus={saveStatus} />
    </div>
  );
};
