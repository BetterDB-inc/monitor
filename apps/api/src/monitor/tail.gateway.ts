import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { IncomingMessage } from 'http';
import { Socket } from 'net';
import { WebSocket, WebSocketServer } from 'ws';
import { StoragePort } from '../common/interfaces/storage-port.interface';
import { CaptureWriter } from './capture-writer';
import { MonitorCaptureService } from './monitor-capture.service';

/**
 * Inbound message from the viewer: pause / resume the live stream.
 * Pause buffers new lines server-side; resume drains the buffer in order.
 */
interface ControlMessage {
  type: 'pause' | 'resume';
}

/**
 * Outbound messages sent to the viewer.
 *  - line: a single MONITOR-formatted line
 *  - status: lifecycle / connection state (e.g. 'historical_complete', 'session_ended')
 *  - error: a fatal-for-this-connection error; the server will close after sending
 */
type OutboundMessage =
  | { type: 'line'; line: string }
  | { type: 'status'; status: string }
  | { type: 'error'; error: string };

const MAX_BUFFERED_WHILE_PAUSED = 50_000;

@Injectable()
export class TailGateway implements OnModuleDestroy {
  private readonly logger = new Logger(TailGateway.name);
  private readonly wss: WebSocketServer;

  constructor(
    private readonly captureService: MonitorCaptureService,
    @Inject('STORAGE_CLIENT')
    private readonly storage: StoragePort,
  ) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    this.logger.log('Monitor tail WebSocket gateway initialized');
  }

  onModuleDestroy(): void {
    for (const client of this.wss.clients) {
      client.close(1001, 'Server shutting down');
    }
    this.wss.close();
  }

  /**
   * Called by main.ts on HTTP upgrade matching /monitor/ws.
   *
   * The HTTP-level DemoModeGuard does NOT run on WebSocket upgrades, so we
   * enforce the demo-host restriction here. We also gate on the dev preview
   * env var to mirror the HTTP guard behaviour for the rest of the surface.
   */
  handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
    if (process.env.MONITOR_DEV_PREVIEW !== 'true') {
      this.logger.debug('Tail upgrade rejected: dev preview disabled');
      socket.destroy();
      return;
    }

    const host = request.headers.host || '';
    if (process.env.DEMO_HOSTNAME && host === process.env.DEMO_HOSTNAME) {
      this.logger.debug(`Tail upgrade rejected: demo host ${host}`);
      socket.destroy();
      return;
    }

    let sessionId: string | null = null;
    try {
      const url = new URL(request.url || '', `http://${host || 'localhost'}`);
      sessionId = url.searchParams.get('sessionId');
    } catch {
      // fall through; sessionId stays null
    }

    if (!sessionId) {
      this.logger.debug('Tail upgrade rejected: missing sessionId query param');
      socket.destroy();
      return;
    }

    const requestedSessionId = sessionId;
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.handleConnection(ws, requestedSessionId).catch((err: Error) => {
        this.logger.error(`Tail connection setup failed: ${err.message}`);
        send(ws, { type: 'error', error: err.message });
        ws.close();
      });
    });
  }

  /**
   * Per-connection lifecycle. Active sessions stream backlog from the writer's
   * ring buffer then subscribe to new lines; historical sessions stream chunks
   * from storage and close.
   */
  private async handleConnection(ws: WebSocket, sessionId: string): Promise<void> {
    const session = await this.captureService.getSession(sessionId);
    if (!session) {
      send(ws, { type: 'error', error: `session ${sessionId} not found` });
      ws.close();
      return;
    }

    const writer = this.captureService.getActiveWriter(session.connectionId);
    const isLive =
      writer !== undefined &&
      writer.getCounters !== undefined &&
      // the writer for this connection is for THIS session id only when running
      session.status === 'running';

    // Per-viewer pause/resume state — these are independent across viewers.
    let paused = false;
    const pausedBuffer: string[] = [];

    ws.on('message', (data: Buffer | string) => {
      let msg: ControlMessage;
      try {
        msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf-8'));
      } catch {
        send(ws, { type: 'error', error: 'invalid JSON control message' });
        return;
      }
      if (msg.type === 'pause') {
        paused = true;
      } else if (msg.type === 'resume') {
        paused = false;
        while (pausedBuffer.length > 0 && ws.readyState === WebSocket.OPEN) {
          send(ws, { type: 'line', line: pausedBuffer.shift() as string });
        }
      }
    });

    if (isLive && writer) {
      this.streamLive(ws, writer, () => paused, pausedBuffer);
    } else {
      await this.streamHistorical(ws, sessionId);
    }
  }

  private streamLive(
    ws: WebSocket,
    writer: CaptureWriter,
    isPaused: () => boolean,
    pausedBuffer: string[],
  ): void {
    // Send the existing ring-buffer backlog so a viewer joining mid-session
    // has immediate context.
    for (const line of writer.getRingBuffer()) {
      if (ws.readyState !== WebSocket.OPEN) return;
      send(ws, { type: 'line', line });
    }

    const unsubscribeLine = writer.subscribe((line) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (isPaused()) {
        // Drop oldest if a paused viewer falls hopelessly behind; better than
        // a runaway-memory bug for one disconnected viewer.
        if (pausedBuffer.length >= MAX_BUFFERED_WHILE_PAUSED) {
          pausedBuffer.shift();
        }
        pausedBuffer.push(line);
        return;
      }
      send(ws, { type: 'line', line });
    });

    const unsubscribeEnd = writer.onEnd(() => {
      send(ws, { type: 'status', status: 'session_ended' });
      ws.close();
    });

    ws.on('close', () => {
      unsubscribeLine();
      unsubscribeEnd();
    });
  }

  private async streamHistorical(ws: WebSocket, sessionId: string): Promise<void> {
    const chunks = await this.storage.getCaptureChunks(sessionId);
    for (const chunk of chunks) {
      if (ws.readyState !== WebSocket.OPEN) return;
      const lines = chunk.bytes.toString('utf-8').split('\n');
      for (const line of lines) {
        if (line.length === 0) continue;
        if (ws.readyState !== WebSocket.OPEN) return;
        send(ws, { type: 'line', line });
      }
    }
    if (ws.readyState === WebSocket.OPEN) {
      send(ws, { type: 'status', status: 'historical_complete' });
      ws.close();
    }
  }
}

function send(ws: WebSocket, msg: OutboundMessage): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(msg));
}
