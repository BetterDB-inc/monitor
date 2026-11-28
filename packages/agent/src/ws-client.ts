import WebSocket from 'ws';
import { rootCertificates } from 'tls';

const MAX_RECONNECT_DELAY_MS = 30000;
const REPLACED_CLOSE_CODE = 4003;

export interface WsClientOptions {
  url: string;
  token: string;
  /** Extra CA (PEM) trusted for the server certificate, in addition to Node's bundled root CAs. */
  ca?: string;
  /** Prefix for log lines; defaults to [Agent]. */
  logPrefix?: string;
  onMessage: (data: string) => void;
  onOpen: () => void;
  onClose: (code: number, reason: string) => void;
  onError: (err: Error) => void;
  /**
   * Whether an open socket counts as a successful connection (the default).
   * When false, the backoff only resets on markHealthy(): a server that
   * accepts the socket but never acknowledges the client keeps slowing the
   * retries down instead of being hit again every second.
   */
  resetBackoffOnOpen?: boolean;
  /** Longest delay between reconnects; defaults to 30 s. */
  maxReconnectDelayMs?: number;
}

export class WsClient {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  private readonly tag: string;

  constructor(private readonly options: WsClientOptions) {
    this.tag = options.logPrefix ?? '[Agent]';
  }

  connect(): void {
    if (this.closed) return;

    this.ws = new WebSocket(this.options.url, {
      headers: { Authorization: `Bearer ${this.options.token}` },
      // `ca` replaces the trust store, so the public roots come along with it.
      ...(this.options.ca ? { ca: [...rootCertificates, this.options.ca] } : {}),
    });

    this.ws.on('open', () => {
      if (this.options.resetBackoffOnOpen !== false) this.reconnectAttempt = 0;
      this.startHeartbeat();
      this.options.onOpen();
    });

    this.ws.on('message', (data) => {
      const str = data.toString();
      // Handle pong internally
      try {
        const msg = JSON.parse(str);
        if (msg.type === 'pong') {
          this.clearPongTimer();
          return;
        }
        if (msg.type === 'ping') {
          this.ws?.send(JSON.stringify({ type: 'pong', ts: msg.ts }));
          return;
        }
      } catch {
        // not JSON, pass through
      }
      this.options.onMessage(str);
    });

    this.ws.on('close', (code, reason) => {
      this.stopHeartbeat();
      this.options.onClose(code, reason.toString());
      if (code === REPLACED_CLOSE_CODE) {
        console.warn(
          `${this.tag} Another agent is connected with this token ` +
          '(a duplicate, or a previous instance still shutting down). Retrying in 30 s.',
        );
      }
      this.scheduleReconnect(code === REPLACED_CLOSE_CODE);
    });

    this.ws.on('error', (err) => {
      this.options.onError(err);
    });
  }

  send(data: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** The server acknowledged this connection: the next reconnect starts from the shortest delay. */
  markHealthy(): void {
    this.reconnectAttempt = 0;
  }

  /** Closes the current socket only; the usual backoff connects again. */
  dropConnection(code: number, reason: string): void {
    this.ws?.close(code, reason);
  }

  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, 'Agent shutting down');
      this.ws = null;
    }
  }

  private startHeartbeat(): void {
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
        this.pongTimer = setTimeout(() => {
          console.error(`${this.tag} Pong timeout, closing connection`);
          this.ws?.close(4000, 'Pong timeout');
        }, 10000);
      }
    }, 30000);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.clearPongTimer();
  }

  private clearPongTimer(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private scheduleReconnect(replaced: boolean): void {
    if (this.closed) return;

    const maxDelay = this.options.maxReconnectDelayMs ?? MAX_RECONNECT_DELAY_MS;
    const delay = replaced
      ? MAX_RECONNECT_DELAY_MS
      : Math.min(1000 * Math.pow(2, this.reconnectAttempt), maxDelay);
    this.reconnectAttempt++;
    console.log(`${this.tag} Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }
}
