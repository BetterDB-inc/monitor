export const NODE_CONNECT_TIMEOUT_MS = 10_000;

export const NODE_CONNECT_OPTIONS = {
  lazyConnect: true as const,
  retryStrategy: (): null => null,
  connectTimeout: NODE_CONNECT_TIMEOUT_MS,
};

interface ConnectableClient {
  connect(): Promise<unknown>;
  disconnect(): void;
}

export async function connectWithin(client: ConnectableClient, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      client.disconnect();
      reject(new Error(`connect timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    await Promise.race([client.connect(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
