import type Valkey from 'iovalkey';
import type { DatabaseCapabilities, DatabasePort } from '../common/interfaces/database-port.interface';
import type { InfoResponse } from '../common/types/metrics.types';
import { InfoParser } from '../database/parsers/info.parser';
import { MetricsParser } from '../database/parsers/metrics.parser';
import { ExternalConnectionUnsupportedError } from './external-connection-unsupported.error';
import type { ExternalMetricsStore, InfoSections } from './external-metrics-store';

const SECTION_TITLES: Record<string, string> = {
  server: 'Server',
  clients: 'Clients',
  memory: 'Memory',
  persistence: 'Persistence',
  stats: 'Stats',
  replication: 'Replication',
  cpu: 'CPU',
  commandstats: 'Commandstats',
  keyspace: 'Keyspace',
};

const EXCLUDED_BY_DEFAULT = new Set(['commandstats']);

const HUMAN_BYTES_FIELDS: ReadonlyArray<readonly [string, string]> = [
  ['used_memory', 'used_memory_human'],
  ['used_memory_rss', 'used_memory_rss_human'],
  ['used_memory_peak', 'used_memory_peak_human'],
];

const BYTE_UNITS = ['K', 'M', 'G', 'T', 'P'];

const SECONDS_PER_DAY = 86_400;

function bytesToHuman(raw: string): string | null {
  const bytes = Number(raw);
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${Math.floor(bytes)}B`;
  let scaled = bytes;
  for (const unit of BYTE_UNITS) {
    scaled /= 1024;
    if (scaled < 1024) return `${scaled.toFixed(2)}${unit}`;
  }
  return `${Math.floor(bytes)}B`;
}

function withPresentationFields(snapshot: InfoSections): InfoSections {
  const memory = snapshot.memory;
  if (memory) {
    for (const [source, target] of HUMAN_BYTES_FIELDS) {
      const human = memory[source] === undefined ? null : bytesToHuman(memory[source]);
      if (human !== null) memory[target] = human;
    }
  }
  const server = snapshot.server;
  const uptime = server?.uptime_in_seconds === undefined ? NaN : Number(server.uptime_in_seconds);
  if (server && Number.isFinite(uptime) && uptime >= 0) {
    server.uptime_in_days = String(Math.floor(uptime / SECONDS_PER_DAY));
  }
  return snapshot;
}

export class ExternalMetricsAdapter implements DatabasePort {
  constructor(
    private readonly connectionId: string,
    private readonly store: ExternalMetricsStore,
    private readonly now: () => number = Date.now,
  ) {}

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  isConnected(): boolean {
    return this.store.isFresh(this.connectionId, this.now());
  }

  async ping(): Promise<boolean> {
    return this.isConnected();
  }

  sampleVersion(): number | null {
    return this.store.latestVersion(this.connectionId);
  }

  async getInfo(sections?: string[]): Promise<Record<string, unknown>> {
    return InfoParser.parse(this.renderInfo(sections));
  }

  async getInfoParsed(sections?: string[]): Promise<InfoResponse> {
    return MetricsParser.parseInfoToTyped(await this.getInfo(sections));
  }

  getCapabilities(): DatabaseCapabilities {
    return {
      dbType: this.store.isValkey(this.connectionId) ? 'valkey' : 'redis',
      version: this.store.serverVersion(this.connectionId) ?? 'unknown',
      hasCommandLog: false,
      hasSlotStats: false,
      hasClusterSlotStats: false,
      hasLatencyMonitor: false,
      hasAclLog: false,
      hasMemoryDoctor: false,
      hasConfig: false,
      hasVectorSearch: false,
    };
  }

  getClient(): Valkey {
    throw new ExternalConnectionUnsupportedError('getClient');
  }

  getSlowLog() { return this.unsupported('getSlowLog'); }
  getSlowLogLength() { return this.unsupported('getSlowLogLength'); }
  resetSlowLog() { return this.unsupported('resetSlowLog'); }
  getCommandLog() { return this.unsupported('getCommandLog'); }
  getCommandLogLength() { return this.unsupported('getCommandLogLength'); }
  resetCommandLog() { return this.unsupported('resetCommandLog'); }
  getLatestLatencyEvents() { return this.unsupported('getLatestLatencyEvents'); }
  getLatencyHistory() { return this.unsupported('getLatencyHistory'); }
  getLatencyHistogram() { return this.unsupported('getLatencyHistogram'); }
  resetLatencyEvents() { return this.unsupported('resetLatencyEvents'); }
  getLatencyDoctor() { return this.unsupported('getLatencyDoctor'); }
  getMemoryStats() { return this.unsupported('getMemoryStats'); }
  getMemoryDoctor() { return this.unsupported('getMemoryDoctor'); }
  getClients() { return this.unsupported('getClients'); }
  getClientById() { return this.unsupported('getClientById'); }
  killClient() { return this.unsupported('killClient'); }
  getAclLog() { return this.unsupported('getAclLog'); }
  resetAclLog() { return this.unsupported('resetAclLog'); }
  getAclUsers() { return this.unsupported('getAclUsers'); }
  getAclList() { return this.unsupported('getAclList'); }
  getRole() { return this.unsupported('getRole'); }
  getClusterInfo() { return this.unsupported('getClusterInfo'); }
  getClusterNodes() { return this.unsupported('getClusterNodes'); }
  getClusterShards() { return this.unsupported('getClusterShards'); }
  getSentinelMasters() { return this.unsupported('getSentinelMasters'); }
  getSentinelReplicas() { return this.unsupported('getSentinelReplicas'); }
  getSentinelPeers() { return this.unsupported('getSentinelPeers'); }
  getClusterSlotStats() { return this.unsupported('getClusterSlotStats'); }
  getConfigValue() { return this.unsupported('getConfigValue'); }
  getConfigValues() { return this.unsupported('getConfigValues'); }
  getDbSize() { return this.unsupported('getDbSize'); }
  getLastSaveTime() { return this.unsupported('getLastSaveTime'); }
  collectKeyAnalytics() { return this.unsupported('collectKeyAnalytics'); }
  getVectorIndexList() { return this.unsupported('getVectorIndexList'); }
  getVectorIndexInfo() { return this.unsupported('getVectorIndexInfo'); }
  getHashFieldBuffer() { return this.unsupported('getHashFieldBuffer'); }
  vectorSearch() { return this.unsupported('vectorSearch'); }
  textSearch() { return this.unsupported('textSearch'); }
  getTagValues() { return this.unsupported('getTagValues'); }
  getSearchConfig() { return this.unsupported('getSearchConfig'); }
  profileSearch() { return this.unsupported('profileSearch'); }
  call() { return this.unsupported('call'); }

  private unsupported(method: string): Promise<never> {
    return Promise.reject(new ExternalConnectionUnsupportedError(method));
  }

  private renderInfo(sections?: string[]): string {
    const snapshot = withPresentationFields(this.store.snapshot(this.connectionId, this.now()));
    const include = this.sectionFilter(sections);
    const lines: string[] = [];
    for (const [name, title] of Object.entries(SECTION_TITLES)) {
      const fields = snapshot[name];
      if (!include(name) || !fields || Object.keys(fields).length === 0) continue;
      lines.push(`# ${title}`);
      for (const [key, value] of Object.entries(fields)) lines.push(`${key}:${value}`);
      lines.push('');
    }
    return lines.join('\r\n');
  }

  private sectionFilter(sections?: string[]): (name: string) => boolean {
    if (!sections || sections.length === 0) return (name) => !EXCLUDED_BY_DEFAULT.has(name);
    const wanted = new Set(sections.map((s) => s.toLowerCase()));
    if (wanted.has('all') || wanted.has('everything')) return () => true;
    return (name) => wanted.has(name);
  }
}
