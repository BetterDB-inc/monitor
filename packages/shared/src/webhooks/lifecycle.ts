import { WebhookEventType } from './types';

/**
 * Edge-triggered events that open a condition, mapped to the event that
 * closes it. Consumers that track open incidents (PagerDuty resolve, alert
 * suppression replay) key off this single table so the pairs cannot drift.
 */
export const WEBHOOK_RESOLVING_EVENT: Readonly<Partial<Record<WebhookEventType, WebhookEventType>>> = {
  [WebhookEventType.INSTANCE_DOWN]: WebhookEventType.INSTANCE_UP,
  [WebhookEventType.WRITES_REJECTED]: WebhookEventType.WRITES_RECOVERED,
  [WebhookEventType.FAILOVER_STARTED]: WebhookEventType.FAILOVER_COMPLETED,
};

const OPENING_EVENT_BY_RESOLVER: ReadonlyMap<WebhookEventType, WebhookEventType> = new Map(
  (Object.entries(WEBHOOK_RESOLVING_EVENT) as Array<[WebhookEventType, WebhookEventType]>).map(
    ([opening, resolving]) => [resolving, opening],
  ),
);

/** The event that closes `event`, or undefined when `event` does not open a condition. */
export function resolvingEventFor(event: WebhookEventType): WebhookEventType | undefined {
  return WEBHOOK_RESOLVING_EVENT[event];
}

/** The event that `event` closes, or undefined when `event` is not a resolver. */
export function openingEventFor(event: WebhookEventType): WebhookEventType | undefined {
  return OPENING_EVENT_BY_RESOLVER.get(event);
}
