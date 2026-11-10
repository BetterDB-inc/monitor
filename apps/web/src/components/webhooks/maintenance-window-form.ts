import {
  MAX_MAINTENANCE_WINDOW_MS,
  type CreateMaintenanceWindowRequest,
  type WebhookEventType,
} from '@betterdb/shared';

const MINUTE = 60_000;

export const DURATION_PRESETS: ReadonlyArray<{ label: string; ms: number }> = [
  { label: '30 minutes', ms: 30 * MINUTE },
  { label: '1 hour', ms: 60 * MINUTE },
  { label: '2 hours', ms: 120 * MINUTE },
  { label: '4 hours', ms: 240 * MINUTE },
  { label: '8 hours', ms: 480 * MINUTE },
  { label: '24 hours', ms: 1440 * MINUTE },
];

/** Parse a datetime-local value; empty or invalid gives null. */
function parseLocal(value: string): number | null {
  if (value === '') return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export interface FormState {
  name: string;
  reason: string;
  allConnections: boolean;
  startMode: 'now' | 'at';
  startAt: string;
  durationMs: number;
  limitEvents: boolean;
  events: WebhookEventType[];
}

export const INITIAL_FORM: FormState = {
  name: '',
  reason: '',
  allConnections: false,
  startMode: 'now',
  startAt: '',
  durationMs: 60 * MINUTE,
  limitEvents: false,
  events: [],
};

/** Turn the form into an API request, or a message explaining what is wrong. */
export function buildCreateRequest(
  form: FormState,
  connectionId: string | null,
  now: number,
): CreateMaintenanceWindowRequest | string {
  const name = form.name.trim();
  if (name === '') return 'Give the window a name.';
  const startsAt = form.startMode === 'now' ? now : parseLocal(form.startAt);
  if (startsAt === null) return 'Pick a start time.';
  if (form.startMode === 'at' && startsAt < now) return 'The start time is in the past.';
  if (form.durationMs <= 0 || form.durationMs > MAX_MAINTENANCE_WINDOW_MS) return 'Pick a duration of up to 7 days.';
  if (form.limitEvents && form.events.length === 0) return 'Pick at least one event, or silence all events.';
  if (!form.allConnections && connectionId === null) return 'Select a connection first.';
  return {
    name,
    reason: form.reason.trim() === '' ? null : form.reason.trim(),
    connectionId: form.allConnections ? null : connectionId,
    events: form.limitEvents ? form.events : [],
    ...(form.startMode === 'at' ? { startsAt } : {}),
    endsAt: startsAt + form.durationMs,
  };
}
