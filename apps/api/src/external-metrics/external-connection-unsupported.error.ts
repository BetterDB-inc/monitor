export class ExternalConnectionUnsupportedError extends Error {
  constructor(readonly method: string) {
    super(`${method} is not available for OTLP-ingested connections`);
    this.name = 'ExternalConnectionUnsupportedError';
  }
}
