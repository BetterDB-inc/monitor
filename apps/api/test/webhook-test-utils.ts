import * as http from 'http';

export interface ReceivedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: any;
  timestamp: number;
}

/**
 * Mock HTTP server for testing webhook deliveries
 */
export class MockWebhookServer {
  private server: http.Server | null = null;
  private requests: ReceivedRequest[] = [];
  private responseCode = 200;
  private responseDelay = 0;

  async start(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          this.requests.push({
            method: req.method!,
            path: req.url!,
            headers: req.headers,
            body: body ? JSON.parse(body) : null,
            timestamp: Date.now(),
          });

          // Simulate response delay if configured
          setTimeout(() => {
            res.statusCode = this.responseCode;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ received: true }));
          }, this.responseDelay);
        });
      });

      this.server.on('error', reject);
      this.server.listen(port, () => resolve());
    });
  }

  /**
   * Set the HTTP status code to return for subsequent requests
   */
  setResponseCode(code: number): void {
    this.responseCode = code;
  }

  /**
   * Set artificial delay for responses (in milliseconds)
   */
  setResponseDelay(ms: number): void {
    this.responseDelay = ms;
  }

  /**
   * Get all requests received by the server
   */
  getReceivedRequests(): ReceivedRequest[] {
    return [...this.requests];
  }

  /**
   * Get the last request received
   */
  getLastRequest(): ReceivedRequest | undefined {
    return this.requests[this.requests.length - 1];
  }

  /**
   * Clear all recorded requests
   */
  clearReceivedRequests(): void {
    this.requests = [];
  }

  /**
   * Wait for a specific number of requests to be received
   */
  async waitForRequests(count: number, timeoutMs: number = 5000): Promise<ReceivedRequest[]> {
    const startTime = Date.now();
    while (this.requests.length < count) {
      if (Date.now() - startTime > timeoutMs) {
        throw new Error(`Timeout waiting for ${count} requests. Received ${this.requests.length}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return this.getReceivedRequests();
  }

  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

/**
 * Create and start a mock webhook server on the specified port
 */
export async function createMockWebhookServer(port: number): Promise<MockWebhookServer> {
  const server = new MockWebhookServer();
  await server.start(port);
  return server;
}
