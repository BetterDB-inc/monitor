import posthog, { type PostHog } from 'posthog-js';
import type { TelemetryClient } from '../telemetry-client.interface';

const EVENT_MAP: Record<string, string> = {
  page_view: '$pageview',
};

export class PosthogTelemetryClient implements TelemetryClient {
  private readonly client: PostHog;

  constructor(apiKey: string, host?: string) {
    this.client = posthog.init(apiKey, {
      api_host: host || 'https://us.i.posthog.com',
      defaults: '2026-01-30',
      capture_pageview: false,
      capture_pageleave: false,
    })!;
  }

  capture(event: string, properties?: Record<string, unknown>): void {
    this.client.capture(EVENT_MAP[event] ?? event, properties);
  }

  identify(distinctId: string, properties: Record<string, unknown>): void {
    this.client.identify(distinctId, properties);
  }

  shutdown(): void {
    this.client.reset();
  }
}
