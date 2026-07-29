export class CapabilityUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilityUnavailableError';
  }
}
