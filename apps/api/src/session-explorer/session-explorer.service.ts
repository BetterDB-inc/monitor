import { randomUUID } from 'crypto';
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  CapturedKey,
  SessionDetail,
  SessionListResponse,
  SessionNamespace,
  SessionNamespaceInput,
  SessionOversizeResponse,
  SessionPreview,
} from '@betterdb/shared';
import type { StoragePort } from '../common/interfaces/storage-port.interface';
import { ConnectionRegistry } from '../connections/connection-registry.service';
import { validateNamespaceInput } from './namespace-validation';
import { getPreset, parseSessionKeys } from './presets/registry';
import { estimateTokens } from './presets/text';
import type { PresetDefinition } from './presets/types';
import { withPrimaries } from './primary-nodes';
import { keysForSession, scanSessions } from './session-scanner';
import { readSessionKeys } from './session-reader';

const PREVIEW_SCAN_COUNT = 1000;

const sessionMissing = (failedNodes: number) =>
  failedNodes > 0
    ? new ServiceUnavailableException('Session keys may live on primaries that could not be read')
    : new NotFoundException('Session not found');

export interface SessionCapture {
  namespace: SessionNamespace;
  keys: CapturedKey[];
  detail: SessionDetail;
}

const minPositive = (values: number[]): number | null => {
  const positive = values.filter((v) => v > 0);
  return positive.length > 0 ? Math.min(...positive) : null;
};

@Injectable()
export class SessionExplorerService {
  constructor(
    private readonly registry: ConnectionRegistry,
    @Inject('STORAGE_CLIENT') private readonly storage: StoragePort,
  ) {}

  listNamespaces(connectionId: string): Promise<SessionNamespace[]> {
    return this.storage.listSessionNamespaces(connectionId);
  }

  async createNamespace(connectionId: string, body: unknown): Promise<SessionNamespace> {
    const input = this.validate(body);
    const now = Date.now();
    return this.storage.saveSessionNamespace({
      ...input,
      id: randomUUID(),
      connectionId,
      createdAt: now,
      updatedAt: now,
    });
  }

  async updateNamespace(connectionId: string, id: string, body: unknown): Promise<SessionNamespace> {
    const input = this.validate(body);
    const existing = await this.namespace(connectionId, id);
    return this.storage.saveSessionNamespace({
      ...existing,
      ...input,
      updatedAt: Math.max(Date.now(), existing.updatedAt + 1),
    });
  }

  async deleteNamespace(connectionId: string, id: string): Promise<void> {
    if (!(await this.storage.deleteSessionNamespace(connectionId, id))) {
      throw new NotFoundException('Namespace not found');
    }
  }

  async preview(connectionId: string, body: unknown): Promise<SessionPreview> {
    const input = this.validate(body);
    const preset = this.presetOf(input);
    const db = this.registry.get(connectionId);
    const sampleKey = await withPrimaries(db, async ({ clients, failed }) => {
      let lastError: unknown;
      let succeeded = 0;
      for (const client of clients) {
        try {
          const [, page] = await client.scan('0', 'MATCH', input.pattern, 'COUNT', PREVIEW_SCAN_COUNT);
          succeeded++;
          const key = page.find((k) => preset.sessionIdOf(k) !== null) ?? page[0];
          if (key !== undefined) return key;
        } catch (err) {
          lastError = err;
        }
      }
      if (succeeded === 0 && lastError !== undefined) throw lastError;
      if (succeeded === 0 && failed > 0) {
        throw new ServiceUnavailableException('No primary could be reached');
      }
      return null;
    });
    if (sampleKey === null) return { sampleKey: null, view: null };
    const read = await readSessionKeys(db, [sampleKey]);
    const captured = read.keys[0];
    return { sampleKey, view: captured ? preset.parseKey(captured) : null };
  }

  async listSessions(connectionId: string, id: string): Promise<SessionListResponse> {
    const namespace = await this.namespace(connectionId, id);
    return scanSessions(this.registry.get(connectionId), namespace.pattern, this.presetOf(namespace));
  }

  async oversizeSessions(connectionId: string, id: string): Promise<SessionOversizeResponse> {
    const namespace = await this.namespace(connectionId, id);
    const list = await scanSessions(
      this.registry.get(connectionId),
      namespace.pattern,
      this.presetOf(namespace),
    );
    const thresholdBytes = namespace.oversizeThresholdBytes;
    const oversize = list.sessions.filter((s) => s.memoryBytes > thresholdBytes);
    return {
      thresholdBytes,
      sessionIds: oversize.map((s) => s.sessionId),
      unmeasuredSessionIds: list.sessions
        .filter((s) => s.unmeasuredKeys > 0 && !oversize.includes(s))
        .map((s) => s.sessionId),
      truncated: list.truncated,
      partial: list.partial,
      failedNodes: list.failedNodes,
    };
  }

  async getSession(connectionId: string, id: string, sessionId: string): Promise<SessionDetail> {
    return (await this.captureSession(connectionId, id, sessionId)).detail;
  }

  async captureSession(connectionId: string, id: string, sessionId: string): Promise<SessionCapture> {
    const namespace = await this.namespace(connectionId, id);
    const preset = this.presetOf(namespace);
    const db = this.registry.get(connectionId);
    const scan = await keysForSession(db, namespace.pattern, preset, sessionId);
    if (scan.keys.length === 0) throw sessionMissing(scan.failedNodes);
    const selected = preset.selectKeys ? preset.selectKeys(scan.keys) : scan.keys;
    const read = await readSessionKeys(db, selected);
    if (read.keys.length === 0) throw sessionMissing(read.failedNodes);

    const views = parseSessionKeys(preset, read.keys);
    const messages = preset.mergeSession(views);
    const unparsedKeys = views.filter((v) => !v.parsed).length;
    const truncated = scan.truncated || read.truncated;
    const failedNodes = Math.max(scan.failedNodes, read.failedNodes);
    const complete =
      unparsedKeys === 0 &&
      !truncated &&
      failedNodes === 0 &&
      read.missingKeys === 0 &&
      read.keys.every((k) => !k.truncated);

    return {
      namespace,
      keys: read.keys,
      detail: {
        sessionId,
        preset: namespace.preset,
        keys: views,
        messages,
        estimatedTokens: estimateTokens(messages),
        ttlMs: minPositive(read.keys.map((k) => k.pttl)),
        memoryBytes: read.keys.reduce((sum, k) => sum + (k.bytes ?? 0), 0),
        complete,
        unparsedKeys,
        truncated,
        failedNodes,
        missingKeys: read.missingKeys,
      },
    };
  }

  private validate(body: unknown): SessionNamespaceInput {
    const result = validateNamespaceInput(body);
    if (!result.ok) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'Invalid namespace',
        errors: result.errors,
      });
    }
    return result.value;
  }

  private async namespace(connectionId: string, id: string): Promise<SessionNamespace> {
    const namespace = await this.storage.getSessionNamespace(connectionId, id);
    if (!namespace) throw new NotFoundException('Namespace not found');
    return namespace;
  }

  private presetOf(
    ns: Pick<SessionNamespace, 'preset' | 'customSchema' | 'pattern'>,
  ): PresetDefinition {
    return getPreset(ns.preset, ns.customSchema, ns.pattern);
  }
}
