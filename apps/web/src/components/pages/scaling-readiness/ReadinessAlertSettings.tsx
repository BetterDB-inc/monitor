import { useEffect, useState } from 'react';
import {
  MAX_SCALING_READINESS_ALERT_THRESHOLD,
  type ScalingReadinessSettings,
  type ScalingReadinessSettingsUpdate,
} from '@betterdb/shared';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card';
import { Input } from '../../ui/input';
import { Switch } from '../../ui/switch';

const isValidThreshold = (value: number) =>
  Number.isInteger(value) && value >= 1 && value <= MAX_SCALING_READINESS_ALERT_THRESHOLD;

export function ReadinessAlertSettings({
  settings,
  onChange,
  saveStatus,
}: {
  settings: ScalingReadinessSettings;
  onChange: (update: ScalingReadinessSettingsUpdate) => void;
  saveStatus: 'idle' | 'saved' | 'error';
}) {
  const [threshold, setThreshold] = useState(String(settings.alertThreshold));

  useEffect(() => {
    setThreshold(String(settings.alertThreshold));
  }, [settings.alertThreshold]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle>Alert</CardTitle>
        {saveStatus === 'saved' ? <span className="text-xs text-muted-foreground">Saved</span> : null}
        {saveStatus === 'error' ? <span className="text-xs text-destructive">Save failed</span> : null}
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-6">
        <label className="flex items-center gap-2 text-sm">
          <Switch
            aria-label="Alert when the score drops"
            checked={settings.alertEnabled}
            onCheckedChange={(checked: boolean) => onChange({ alertEnabled: checked })}
          />
          Alert when the score drops
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span>Alert threshold</span>
          <Input
            aria-label="Alert threshold"
            type="number"
            min={1}
            max={MAX_SCALING_READINESS_ALERT_THRESHOLD}
            className="w-20"
            value={threshold}
            disabled={!settings.alertEnabled}
            onBlur={() => {
              if (threshold === '' || !isValidThreshold(Number(threshold))) {
                setThreshold(String(settings.alertThreshold));
              }
            }}
            onChange={(e) => {
              setThreshold(e.target.value);
              const value = Number(e.target.value);
              if (isValidThreshold(value)) onChange({ alertThreshold: value });
            }}
          />
        </label>
        <p className="w-full text-xs text-muted-foreground">
          Sends the scaling_readiness.low webhook once when the score drops to or below the
          threshold, and again only after it recovers.
        </p>
      </CardContent>
    </Card>
  );
}
