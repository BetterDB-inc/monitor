import type { PlacementMaintenanceWindow, PlacementSettings } from '@betterdb/shared';

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const GIB = 1024 ** 3;
const LAST_SLOT = 16383;

export type NumberField =
  | 'triggerRatio'
  | 'resolveRatio'
  | 'nodeCpuLimitUsecPerSecond'
  | 'sustainMinutes'
  | 'slotCooldownDays'
  | 'noReturnDays'
  | 'maxMigrationsPerHour'
  | 'abortLatencyMs'
  | 'verifyMinutes'
  | 'verifyTolerance';

export type OptionalNumberField = 'maxCpuShare' | 'maxNetworkShare';

export interface PlacementPolicyForm {
  numbers: Record<NumberField, string>;
  optional: Record<OptionalNumberField, string>;
  maxGibPerHour: string;
  maintenanceWindows: string;
  excludedShardIds: string;
  excludedSlots: string;
  autoRollback: boolean;
}

export type FormResult =
  | { ok: true; settings: PlacementSettings }
  | { ok: false; errors: string[] };

const NUMBER_FIELDS: NumberField[] = [
  'triggerRatio',
  'resolveRatio',
  'nodeCpuLimitUsecPerSecond',
  'sustainMinutes',
  'slotCooldownDays',
  'noReturnDays',
  'maxMigrationsPerHour',
  'abortLatencyMs',
  'verifyMinutes',
  'verifyTolerance',
];

function windowText(window: PlacementMaintenanceWindow): string {
  const days = window.days.map((day) => DAY_NAMES[day] ?? String(day)).join(',');
  return `${days} ${window.start} ${window.durationMinutes}`;
}

function slotText(slots: number[]): string {
  const sorted = [...new Set(slots)].sort((a, b) => a - b);
  const ranges: string[] = [];
  let index = 0;
  while (index < sorted.length) {
    let end = index;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) end += 1;
    ranges.push(end === index ? `${sorted[index]}` : `${sorted[index]}-${sorted[end]}`);
    index = end + 1;
  }
  return ranges.join(', ');
}

export function formOf(settings: PlacementSettings): PlacementPolicyForm {
  return {
    numbers: Object.fromEntries(
      NUMBER_FIELDS.map((field) => [field, String(settings[field])]),
    ) as Record<NumberField, string>,
    optional: {
      maxCpuShare: settings.maxCpuShare === null ? '' : String(settings.maxCpuShare),
      maxNetworkShare: settings.maxNetworkShare === null ? '' : String(settings.maxNetworkShare),
    },
    maxGibPerHour: String(settings.maxBytesPerHour / GIB),
    maintenanceWindows: settings.maintenanceWindows.map(windowText).join('\n'),
    excludedShardIds: settings.excludedShardIds.join('\n'),
    excludedSlots: slotText(settings.excludedSlots),
    autoRollback: settings.autoRollback,
  };
}

function numberOf(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function dayOf(text: string): number | null {
  const name = DAY_NAMES.findIndex((day) => day.toLowerCase() === text.toLowerCase());
  return name >= 0 ? name : null;
}

function windowsOf(text: string, errors: string[]): PlacementMaintenanceWindow[] {
  const windows: PlacementMaintenanceWindow[] = [];
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .forEach((line, index) => {
      const [dayList, start, minutes, ...rest] = line.split(/\s+/);
      const days = (dayList ?? '').split(',').map(dayOf);
      const durationMinutes = numberOf(minutes ?? '');
      if (
        rest.length > 0 ||
        !start ||
        durationMinutes === null ||
        days.some((day) => day === null)
      ) {
        errors.push(
          `Maintenance window ${index + 1}: write it as days, start and minutes, for example "Mon,Tue 02:00 120"`,
        );
        return;
      }
      windows.push({ days: days as number[], start, durationMinutes });
    });
  return windows;
}

function slotsOf(text: string, errors: string[]): number[] {
  const slots: number[] = [];
  for (const part of text.split(/[\s,]+/).filter((each) => each !== '')) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    const from = match ? Number(match[1]) : NaN;
    const to = match?.[2] === undefined ? from : Number(match[2]);
    if (!match || to < from || to > LAST_SLOT) {
      errors.push(
        `Excluded slots: "${part}" is not a slot from 0 to ${LAST_SLOT} or a range like 100-109`,
      );
      continue;
    }
    for (let slot = from; slot <= to; slot += 1) slots.push(slot);
  }
  return slots;
}

export function settingsOf(form: PlacementPolicyForm): FormResult {
  const errors: string[] = [];
  const numbers = {} as Record<NumberField, number>;
  for (const field of NUMBER_FIELDS) {
    const value = numberOf(form.numbers[field]);
    if (value === null) errors.push(`${field}: enter a number`);
    else numbers[field] = value;
  }
  const optional = {} as Record<OptionalNumberField, number | null>;
  for (const field of ['maxCpuShare', 'maxNetworkShare'] as const) {
    const text = form.optional[field];
    const value = numberOf(text);
    if (text.trim() !== '' && value === null)
      errors.push(`${field}: enter a number or leave it empty`);
    optional[field] = value;
  }
  const gib = numberOf(form.maxGibPerHour);
  if (gib === null) errors.push('maxBytesPerHour: enter a number of GiB');
  const maintenanceWindows = windowsOf(form.maintenanceWindows, errors);
  const excludedSlots = slotsOf(form.excludedSlots, errors);
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    settings: {
      ...numbers,
      ...optional,
      maxBytesPerHour: Math.round((gib as number) * GIB),
      maintenanceWindows,
      excludedShardIds: form.excludedShardIds.split(/[\s,]+/).filter((each) => each !== ''),
      excludedSlots,
      autoRollback: form.autoRollback,
    },
  };
}
