import posthog from 'posthog-js';
import type { TelemetryClient } from '../telemetry-client.interface';

const EVENT_MAP: Record<string, string> = {
  page_view: '$pageview',
};

export class PosthogTelemetryClient implements TelemetryClient {
  constructor(apiKey: string, host?: string) {
    posthog.init(apiKey, {
      api_host: host ?? 'https://us.i.posthog.com',
      capture_pageview: false,
      capture_pageleave: false,
    });
  }

  capture(event: string, properties?: Record<string, unknown>): void {
    posthog.capture(EVENT_MAP[event] ?? event, properties);
  }

  identify(distinctId: string, properties: Record<string, unknown>): void {
    posthog.identify(distinctId, properties);
  }

  shutdown(): void {
    posthog.reset();
  }
}
