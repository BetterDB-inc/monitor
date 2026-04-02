import { TelemetryPort, TelemetryEvent } from '../../common/interfaces/telemetry-port.interface';

export class HttpTelemetryClientAdapter implements TelemetryPort {
  private readonly pendingControllers = new Set<AbortController>();

  constructor(private readonly telemetryUrl: string) {}

  capture(event: TelemetryEvent): void {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    this.pendingControllers.add(controller);

    fetch(this.telemetryUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal: controller.signal,
    })
      .catch(() => {
        // fire-and-forget
      })
      .finally(() => {
        clearTimeout(timer);
        this.pendingControllers.delete(controller);
      });
  }

  identify(_distinctId: string, _properties: Record<string, unknown>): void {}

  async shutdown(): Promise<void> {
    for (const controller of this.pendingControllers) {
      controller.abort();
    }
    this.pendingControllers.clear();
  }
}
