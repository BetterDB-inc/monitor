import type { ScalingReadinessSettings, ScalingReadinessSettingsUpdate } from '@betterdb/shared';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card';
import { Input } from '../../ui/input';
import { Switch } from '../../ui/switch';

export function ReadinessAlertSettings({
  settings,
  onChange,
  saveStatus,
}: {
  settings: ScalingReadinessSettings;
  onChange: (update: ScalingReadinessSettingsUpdate) => void;
  saveStatus: 'idle' | 'saved' | 'error';
}) {
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
            max={99}
            className="w-20"
            defaultValue={settings.alertThreshold}
            disabled={!settings.alertEnabled}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (Number.isInteger(value) && value >= 1 && value <= 99) onChange({ alertThreshold: value });
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
