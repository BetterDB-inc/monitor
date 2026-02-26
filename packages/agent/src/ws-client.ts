import WebSocket from 'ws';

export interface WsClientOptions {
  url: string;
  token: string;
  onMessage: (data: string) => void;
  onOpen: () => void;
  onClose: (code: number, reason: string) => void;
  onError: (err: Error) => void;
}

export class WsClient {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly options: WsClientOptions) { }

  connect(): void {
    if (this.closed) return;

    this.ws = new WebSocket(this.options.url, {
      headers: { Authorization: `Bearer ${this.options.token}` },
    });

    this.ws.on('open', () => {
      this.reconnectAttempt = 0;
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
      this.scheduleReconnect();
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
          console.error('[Agent] Pong timeout, closing connection');
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

  private scheduleReconnect(): void {
    if (this.closed) return;

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt), 30000);
    this.reconnectAttempt++;
    console.log(`[Agent] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }
}
