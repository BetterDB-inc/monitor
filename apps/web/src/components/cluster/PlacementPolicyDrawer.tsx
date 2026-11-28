import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { PlacementPolicySaved, PlacementSettings } from '@betterdb/shared';
import { ApiError } from '../../api/client';
import { useCanMutate } from '../../hooks/useCanMutate';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '../ui/sheet';
import { Switch } from '../ui/switch';
import {
  formOf,
  settingsOf,
  type NumberField,
  type OptionalNumberField,
  type PlacementPolicyForm,
} from './placement-policy-form';

const NUMBER_FIELDS: { field: NumberField; label: string; hint: string; step: string }[] = [
  {
    field: 'triggerRatio',
    label: 'Trigger ratio',
    hint: 'A shard over this multiple of the median load is marked hot on the card.',
    step: '0.05',
  },
  {
    field: 'resolveRatio',
    label: 'Resolve ratio',
    hint: 'A suggested slot move aims to bring the hot shard under this multiple of the median. Must be below the trigger ratio and below 1.5.',
    step: '0.05',
  },
  {
    field: 'nodeCpuLimitUsecPerSecond',
    label: 'Node CPU limit (µs/s)',
    hint: 'A suggested move never takes a target node over this CPU time per second.',
    step: '1000',
  },
  {
    field: 'sustainMinutes',
    label: 'Sustain (minutes)',
    hint: 'How long the sustained load of a shard must stay over the trigger before the trigger fires. The trigger does not move slots yet.',
    step: '1',
  },
  {
    field: 'slotCooldownDays',
    label: 'Slot cooldown (days)',
    hint: 'Not applied yet. How long a slot that moved stays put, except for a rollback.',
    step: '1',
  },
  {
    field: 'noReturnDays',
    label: 'No return (days)',
    hint: 'Not applied yet. How long a slot stays away from a shard it left, except for a rollback.',
    step: '1',
  },
  {
    field: 'maxMigrationsPerHour',
    label: 'Moves per hour',
    hint: 'The safety checks hold a plan back when its moves would go over this in an hour. Each move takes slots from one source to one target.',
    step: '1',
  },
  {
    field: 'abortLatencyMs',
    label: 'Abort latency (ms)',
    hint: 'The safety checks hold a plan back while a source or target node answers PING slower than this, 50 ms at least. Stopping a running move comes later.',
    step: '1',
  },
  {
    field: 'verifyMinutes',
    label: 'Verify (minutes)',
    hint: 'Not applied yet. How long the load is measured after a move to judge it.',
    step: '1',
  },
  {
    field: 'verifyTolerance',
    label: 'Verify tolerance',
    hint: 'Not applied yet. A move that drops the source CPU by less than this share of the projected drop counts as ineffective.',
    step: '0.05',
  },
];

const OPTIONAL_FIELDS: { field: OptionalNumberField; label: string; hint: string }[] = [
  {
    field: 'maxCpuShare',
    label: 'CPU share limit',
    hint: 'A share (0 to 1) of the sustained slot CPU of the cluster that also counts as over the trigger, with 3 or more shards. Empty for none.',
  },
  {
    field: 'maxNetworkShare',
    label: 'Network share limit',
    hint: 'Not applied yet. A share of the network traffic that makes a shard hot for advice only. Empty for none.',
  },
];

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-xs font-medium">
        {label}
      </label>
      {children}
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

const TEXTAREA =
  'w-full px-3 py-2 border rounded-md bg-background font-mono text-xs focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50';

function errorsOf(err: unknown): string[] {
  if (err instanceof ApiError && err.status === 409) {
    return [
      'Someone saved the policy after you opened it. Close and open it again to see their version.',
    ];
  }
  if (err instanceof ApiError && typeof err.payload === 'object' && err.payload !== null) {
    const { errors } = err.payload as { errors?: unknown };
    if (
      Array.isArray(errors) &&
      errors.every((each) => typeof each === 'string') &&
      errors.length > 0
    ) {
      return errors;
    }
  }
  return [err instanceof Error ? err.message : 'Failed to save the placement policy'];
}

function fieldOfError(error: string): string | null {
  if (error.startsWith('Maintenance window')) return 'maintenanceWindows';
  if (error.startsWith('Excluded slots')) return 'excludedSlots';
  return /^([A-Za-z]+)[.:]/.exec(error)?.[1] ?? null;
}

const errorId = (index: number) => `placement-error-${index}`;

function PolicyForm({
  settings,
  version,
  onSave,
  onClose,
}: {
  settings: PlacementSettings;
  version: number;
  onSave: (settings: PlacementSettings, version: number) => Promise<PlacementPolicySaved>;
  onClose: () => void;
}) {
  const canMutate = useCanMutate();
  const [form, setForm] = useState<PlacementPolicyForm>(() => formOf(settings));
  const [openedAt, setOpenedAt] = useState(version);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [notExpanded, setNotExpanded] = useState<string | null>(null);
  const alive = useRef(true);
  const readOnly = !canMutate || saving;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const invalid = (field: string) => {
    const ids = errors.flatMap((error, index) =>
      fieldOfError(error) === field ? [errorId(index)] : [],
    );
    return ids.length > 0
      ? { 'aria-invalid': true as const, 'aria-describedby': ids.join(' ') }
      : {};
  };

  const update = (change: Partial<PlacementPolicyForm>) =>
    setForm((current) => ({ ...current, ...change }));

  const numberInput = ({ field, label, hint, step }: (typeof NUMBER_FIELDS)[number]) => (
    <Field key={field} id={`placement-${field}`} label={label} hint={hint}>
      <Input
        id={`placement-${field}`}
        {...invalid(field)}
        type="number"
        step={step}
        value={form.numbers[field]}
        disabled={readOnly}
        onChange={(event) => update({ numbers: { ...form.numbers, [field]: event.target.value } })}
      />
    </Field>
  );

  const save = async () => {
    const result = settingsOf(form);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setSaving(true);
    setErrors([]);
    setNotExpanded(null);
    try {
      const saved = await onSave(result.settings, openedAt);
      if (!alive.current) return;
      if (saved.exclusionsExpanded) {
        onClose();
        return;
      }
      setOpenedAt(saved.policyVersion);
      setNotExpanded(saved.exclusionsExpandProblem ?? 'the cluster did not answer');
    } catch (err) {
      if (alive.current) setErrors(errorsOf(err));
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  return (
    <>
      <div className="flex-1 space-y-4 overflow-y-auto px-4">
        {NUMBER_FIELDS.slice(0, 2).map(numberInput)}
        {OPTIONAL_FIELDS.map(({ field, label, hint }) => (
          <Field key={field} id={`placement-${field}`} label={label} hint={hint}>
            <Input
              id={`placement-${field}`}
              {...invalid(field)}
              type="number"
              step="0.05"
              value={form.optional[field]}
              disabled={readOnly}
              onChange={(event) =>
                update({ optional: { ...form.optional, [field]: event.target.value } })
              }
            />
          </Field>
        ))}
        {NUMBER_FIELDS.slice(2, 7).map(numberInput)}
        <Field
          id="placement-maxBytesPerHour"
          label="GiB moved per hour"
          hint="Moved bytes are not counted yet, so only 0 holds every plan back. An estimate from key counts and the average key size; big keys make it wrong."
        >
          <Input
            id="placement-maxBytesPerHour"
            {...invalid('maxBytesPerHour')}
            type="number"
            step="0.5"
            value={form.maxGibPerHour}
            disabled={readOnly}
            onChange={(event) => update({ maxGibPerHour: event.target.value })}
          />
        </Field>
        <Field
          id="placement-maintenanceWindows"
          label="Maintenance windows"
          hint="A plan outside every window carries a warning. One per line: days, start time (UTC) and minutes, for example Mon,Tue 02:00 120. Empty means any time."
        >
          <textarea
            id="placement-maintenanceWindows"
            {...invalid('maintenanceWindows')}
            rows={3}
            spellCheck={false}
            className={TEXTAREA}
            value={form.maintenanceWindows}
            disabled={readOnly}
            onChange={(event) => update({ maintenanceWindows: event.target.value })}
          />
        </Field>
        <Field
          id="placement-excludedShardIds"
          label="Excluded shards"
          hint="Shards that slots never move off or onto, one per line. Give the node ID of any node of the shard, primary or replica. Saving adds the other nodes of the shard, so it stays excluded after a failover."
        >
          <textarea
            id="placement-excludedShardIds"
            {...invalid('excludedShardIds')}
            rows={2}
            spellCheck={false}
            className={TEXTAREA}
            value={form.excludedShardIds}
            disabled={readOnly}
            onChange={(event) => update({ excludedShardIds: event.target.value })}
          />
        </Field>
        <Field
          id="placement-excludedSlots"
          label="Excluded slots"
          hint="Slots that never move, for example 100-109, 5000."
        >
          <Input
            id="placement-excludedSlots"
            {...invalid('excludedSlots')}
            value={form.excludedSlots}
            disabled={readOnly}
            onChange={(event) => update({ excludedSlots: event.target.value })}
          />
        </Field>
        {NUMBER_FIELDS.slice(7).map(numberInput)}
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="placement-autoRollback" className="text-xs font-medium">
            Roll back worse moves
          </label>
          <Switch
            id="placement-autoRollback"
            checked={form.autoRollback}
            disabled={readOnly}
            onCheckedChange={(checked) => update({ autoRollback: checked })}
          />
        </div>
        {notExpanded && (
          <p role="status" className="text-sm text-amber-600 dark:text-amber-400">
            {`Saved, but the shard's other nodes were not added: ${notExpanded}. A failover can move an excluded shard out of the list. Save again once the cluster answers.`}
          </p>
        )}
        {errors.length > 0 && (
          <ul role="alert" className="list-disc pl-5 text-sm text-destructive">
            {errors.map((error, index) => (
              <li key={error} id={errorId(index)}>
                {error}
              </li>
            ))}
          </ul>
        )}
      </div>
      <SheetFooter>
        {canMutate ? (
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="button" onClick={save} disabled={saving}>
              {saving ? 'Saving...' : 'Save'}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Only an admin can change the policy.</p>
        )}
      </SheetFooter>
    </>
  );
}

export function PlacementPolicyDrawer({
  open,
  onOpenChange,
  settings,
  version,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: PlacementSettings;
  version: number;
  onSave: (settings: PlacementSettings, version: number) => Promise<PlacementPolicySaved>;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Placement policy</SheetTitle>
          <SheetDescription>
            The trigger ratio, sustain minutes and CPU share limit decide when the sustained trigger
            fires; the trigger shows on the card and does not move slots yet. The resolve ratio, the
            node CPU limit and the exclusions shape suggested slot moves now. The safety checks read
            the moves per hour, the GiB moved per hour, the abort latency and the maintenance
            windows. The other limits are checked and saved but do not change anything yet.
          </SheetDescription>
        </SheetHeader>
        {open && (
          <PolicyForm
            settings={settings}
            version={version}
            onSave={onSave}
            onClose={() => onOpenChange(false)}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
