import { TelemetryPort, TelemetryEvent } from '../../common/interfaces/telemetry-port.interface';

interface PendingRequest {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
}

export class HttpTelemetryClientAdapter implements TelemetryPort {
  private readonly pending = new Set<PendingRequest>();

  constructor(private readonly telemetryUrl: string) {}

  capture(event: TelemetryEvent): void {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const entry: PendingRequest = { controller, timer };
    this.pending.add(entry);

    const { version, tier, deploymentMode, workspaceName, timestamp, ...payload } =
      event.properties || {};

    const body = {
      instanceId: event.distinctId,
      eventType: event.event,
      version,
      tier,
      deploymentMode,
      workspaceName,
      timestamp,
      payload: Object.keys(payload).length > 0 ? payload : undefined,
    };

    fetch(this.telemetryUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
      .catch(() => {
        // fire-and-forget
      })
      .finally(() => {
        clearTimeout(timer);
        this.pending.delete(entry);
      });
  }

  identify(_distinctId: string, _properties: Record<string, unknown>): void {}

  async shutdown(): Promise<void> {
    for (const { controller, timer } of this.pending) {
      clearTimeout(timer);
      controller.abort();
    }
    this.pending.clear();
  }
}
