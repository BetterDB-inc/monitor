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
import {
  PrimaryClients,
  PrimaryRoute,
  readable,
  union,
  unreadable,
  withPrimaries,
} from './primary-nodes';
import { keysForSessionOn, scanSessions } from './session-scanner';
import { readSessionKeysOn } from './session-reader';

const PREVIEW_SCAN_COUNT = 1000;
const PREVIEW_SCAN_PAGES = 10;

const sessionMissing = (failedNodes: number) =>
  failedNodes > 0
    ? new ServiceUnavailableException('Session keys may live on primaries that could not be read')
    : new NotFoundException('Session not found');

export interface SessionCapture {
  namespace: SessionNamespace;
  keys: CapturedKey[];
  detail: SessionDetail;
}

async function sampleSessionKey(
  primaries: PrimaryClients,
  pattern: string,
  preset: PresetDefinition,
): Promise<{ sampleKey: string | null; exhausted: boolean; failed: Set<PrimaryRoute> }> {
  let fallback: string | null = null;
  const failed = unreadable(primaries);
  let searchedAll = failed.size === 0;
  let lastError: unknown;
  let succeeded = 0;
  for (const route of readable(primaries)) {
    const { client } = route;
    let cursor = '0';
    let pages = 0;
    try {
      do {
        const [next, page] = await client.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          PREVIEW_SCAN_COUNT,
        );
        cursor = next;
        pages++;
        const accepted = page.find((k) => preset.sessionIdOf(k) !== null);
        if (accepted !== undefined) return { sampleKey: accepted, exhausted: false, failed };
        fallback ??= page[0] ?? null;
      } while (cursor !== '0' && pages < PREVIEW_SCAN_PAGES);
      succeeded++;
    } catch (err) {
      lastError = err;
      failed.add(route);
      cursor = '';
    }
    if (cursor !== '0') searchedAll = false;
  }
  if (succeeded === 0 && fallback === null && lastError !== undefined) throw lastError;
  return { sampleKey: fallback, exhausted: searchedAll, failed };
}

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

  async updateNamespace(
    connectionId: string,
    id: string,
    body: unknown,
  ): Promise<SessionNamespace> {
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
    return withPrimaries(this.registry.get(connectionId), async (primaries) => {
      const { sampleKey, exhausted, failed } = await sampleSessionKey(
        primaries,
        input.pattern,
        preset,
      );
      if (sampleKey === null) {
        return {
          sampleKey: null,
          view: null,
          exhausted,
          failedNodes: failed.size,
          touchesKeys: false,
        };
      }
      const read = await readSessionKeysOn(primaries, [sampleKey]);
      const captured = read.keys[0];
      return {
        sampleKey,
        view: captured ? preset.parseKey(captured) : null,
        exhausted,
        failedNodes: union(failed, read.failed).size,
        touchesKeys: read.touchesKeys,
      };
    });
  }

  async listSessions(connectionId: string, id: string): Promise<SessionListResponse> {
    const namespace = await this.namespace(connectionId, id);
    return scanSessions(
      this.registry.get(connectionId),
      namespace.pattern,
      this.presetOf(namespace),
    );
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

  async captureSession(
    connectionId: string,
    id: string,
    sessionId: string,
  ): Promise<SessionCapture> {
    const namespace = await this.namespace(connectionId, id);
    const preset = this.presetOf(namespace);
    const { scan, read, selected } = await withPrimaries(
      this.registry.get(connectionId),
      async (primaries) => {
        const scan = await keysForSessionOn(primaries, namespace.pattern, preset, sessionId);
        if (scan.keys.length === 0) throw sessionMissing(scan.failed.size);
        const selected = preset.selectKeys ? preset.selectKeys(scan.keys) : scan.keys;
        const read = await readSessionKeysOn(primaries, scan.keys, { selected });
        if (read.keys.length === 0) throw sessionMissing(union(scan.failed, read.failed).size);
        return { scan, read, selected };
      },
    );
    const chosen = new Set(selected);
    const skippedKeys = scan.keys.filter((key) => !chosen.has(key)).length - read.totals.goneKeys;

    const views = parseSessionKeys(preset, read.keys);
    const messages = preset.mergeSession(views);
    const unparsedKeys = views.filter((v) => !v.parsed).length;
    const truncated = scan.truncated || read.truncated;
    const failedNodes = union(scan.failed, read.failed).size;
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
        interrupts: preset.pendingInterrupts?.(views) ?? [],
        estimatedTokens: estimateTokens(messages),
        ttlMs: read.totals.ttlMs,
        memoryBytes: read.keys.reduce((sum, k) => sum + (k.bytes ?? 0), 0),
        totalKeys: scan.keys.length - read.totals.goneKeys,
        skippedKeys,
        totalMemoryBytes: read.totals.memoryBytes,
        unmeasuredKeys: read.totals.unmeasuredKeys,
        selection: skippedKeys > 0 ? (preset.selection ?? null) : null,
        complete,
        unparsedKeys,
        truncated,
        failedNodes,
        missingKeys: read.missingKeys,
        touchesKeys: read.touchesKeys,
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
