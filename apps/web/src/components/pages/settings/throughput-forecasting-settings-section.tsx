import { Toggle } from '../../ui/toggle';

interface ThroughputForecastingSettingsSectionProps {
  throughputForecastingEnabled: boolean;
  throughputForecastingDefaultRollingWindowMs: number;
  throughputForecastingDefaultAlertThresholdMs: number;
  onToggleEnabled: () => void;
  onRollingWindowChange: (value: number) => void;
  onAlertThresholdChange: (value: number) => void;
}

export function ThroughputForecastingSettingsSection({
  throughputForecastingEnabled,
  throughputForecastingDefaultRollingWindowMs,
  throughputForecastingDefaultAlertThresholdMs,
  onToggleEnabled,
  onRollingWindowChange,
  onAlertThresholdChange,
}: ThroughputForecastingSettingsSectionProps) {
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold mb-4">Throughput Forecasting</h2>
      <p className="text-sm text-muted-foreground">
        These defaults are applied when throughput forecasting is first activated for a connection.
        Per-connection settings can be customized on the Throughput Forecast page.
      </p>

      <div className="flex flex-col items-start lg:flex-row lg:items-center gap-6">
        <div className="flex items-center gap-3">
          <label className="block text-sm font-medium">Enable Throughput Forecasting</label>
          <Toggle checked={throughputForecastingEnabled} onChange={onToggleEnabled} />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Default Rolling Window</label>
          <select
            value={throughputForecastingDefaultRollingWindowMs}
            onChange={(e) => onRollingWindowChange(parseInt(e.target.value))}
            className="w-full min-w-48 px-3 py-2 border rounded-md"
          >
            <option value={3600000}>1 hour</option>
            <option value={10800000}>3 hours</option>
            <option value={21600000}>6 hours</option>
            <option value={43200000}>12 hours</option>
            <option value={86400000}>24 hours</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Default Alert Threshold</label>
          <select
            value={throughputForecastingDefaultAlertThresholdMs}
            onChange={(e) => onAlertThresholdChange(parseInt(e.target.value))}
            className="w-full min-w-48 px-3 py-2 border rounded-md"
          >
            <option value={1800000}>30 minutes</option>
            <option value={3600000}>1 hour</option>
            <option value={7200000}>2 hours</option>
            <option value={14400000}>4 hours</option>
          </select>
        </div>
      </div>
    </div>
  );
}
