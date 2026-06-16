import { vi } from 'vitest';

export type CommandHandler = (command: string, ...args: (string | Buffer | number)[]) => unknown;

export interface MockClient {
  call: ReturnType<typeof vi.fn>;
}

/**
 * Minimal iovalkey-style mock: a `call` spy backed by a command handler.
 * Mirrors the FT.* mocking pattern used in semantic-cache's unit tests.
 */
export function mockClient(handler?: CommandHandler): MockClient {
  const defaultHandler: CommandHandler = () => 'OK';
  const impl = handler ?? defaultHandler;
  return {
    call: vi.fn(async (command: string, ...args: (string | Buffer | number)[]) =>
      impl(command, ...args),
    ),
  };
}
