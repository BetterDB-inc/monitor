import { Button } from '../../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card';
import { Input } from '../../ui/input';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../ui/tooltip';
import type { SimulatorInputs } from './measured-inputs';

interface Props {
  inputs: SimulatorInputs;
  hasGrowth: boolean;
  onChange: (inputs: SimulatorInputs) => void;
  onReset: () => void;
}

interface Field {
  key: keyof SimulatorInputs;
  label: string;
  hint: string;
}

export function ProjectionInputs({ inputs, hasGrowth, onChange, onReset }: Props) {
  const fields: Field[] = [
    {
      key: 'keysPerDay',
      label: 'Growth rate (keys/day)',
      hint: hasGrowth ? 'Fitted from the last 30 days of key counts.' : 'Not enough history to fit growth yet; enter your expected rate.',
    },
    { key: 'ttlDays', label: 'Key TTL (days)', hint: 'Leave empty for keys that never expire. With a TTL, growth levels off at rate × TTL.' },
    { key: 'avgKeyBytes', label: 'Average key size (bytes)', hint: 'Measured with MEMORY USAGE on a stratified sample of keys.' },
    { key: 'overheadPerKeyBytes', label: 'Per-key overhead (bytes)', hint: 'Dictionary and expiry bookkeeping per key; 88 bytes is typical.' },
    { key: 'maxmemory', label: 'maxmemory (bytes)', hint: 'Read from INFO. 0 means no limit.' },
  ];
  const update = (key: keyof SimulatorInputs, raw: string) => {
    const value = raw === '' ? null : Number(raw);
    if (key === 'ttlDays') return onChange({ ...inputs, ttlDays: value !== null && value > 0 ? value : null });
    if (value === null || Number.isNaN(value)) return;
    onChange({ ...inputs, [key]: key === 'keysPerDay' ? value : Math.max(0, value) });
  };
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-base">Inputs</CardTitle>
        <Button variant="outline" size="sm" onClick={onReset}>
          Reset to measured
        </Button>
      </CardHeader>
      <CardContent>
        <TooltipProvider>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {fields.map((field) => (
              <div key={field.key} className="space-y-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <label htmlFor={`sim-${field.key}`} className="text-sm text-muted-foreground underline decoration-dotted">
                      {field.label}
                    </label>
                  </TooltipTrigger>
                  <TooltipContent>{field.hint}</TooltipContent>
                </Tooltip>
                <Input
                  id={`sim-${field.key}`}
                  type="number"
                  value={inputs[field.key] === null ? '' : String(Math.round((inputs[field.key] as number) * 100) / 100)}
                  onChange={(event) => update(field.key, event.target.value)}
                />
                {field.key === 'keysPerDay' && !hasGrowth && <p className="text-xs text-muted-foreground">Not enough history to fit growth yet.</p>}
              </div>
            ))}
          </div>
        </TooltipProvider>
      </CardContent>
    </Card>
  );
}
