import { createHash } from 'crypto';
import { createServer, type Server, type Socket } from 'net';
import { encodeReply, error, OK, RespRequestParser, simple, type Reply } from './resp';

const TOTAL_SLOTS = 16384;
const SYNTHETIC_CLIENTS = 20;
const OPS_PER_SECOND = 1200;
const REPL_BYTES_PER_SECOND = 48_000;
const KEYS_PER_SLOT = 3;

const CONTAINER_COMMANDS = new Set([
  'ACL',
  'CLIENT',
  'CLUSTER',
  'COMMAND',
  'COMMANDLOG',
  'CONFIG',
  'DEBUG',
  'FUNCTION',
  'LATENCY',
  'MEMORY',
  'MODULE',
  'OBJECT',
  'PUBSUB',
  'SCRIPT',
  'SLOWLOG',
  'XINFO',
]);

const DEFAULT_INFO_SECTIONS = [
  'server',
  'clients',
  'memory',
  'persistence',
  'stats',
  'replication',
  'cpu',
  'modules',
  'errorstats',
  'cluster',
  'keyspace',
];
const ALL_INFO_SECTIONS = [...DEFAULT_INFO_SECTIONS, 'commandstats', 'latencystats'];

const TRACKED_COMMANDS = ['get', 'set', 'del', 'hget', 'hset', 'expire', 'incr', 'mget', 'ping', 'info', 'cluster|nodes'];

export interface FakeClusterOptions {
  shards: number;
  replicasPerShard: number;
  zones?: string[];
  host?: string;
  version?: string;
}

export interface FakeNode {
  index: number;
  id: string;
  runId: string;
  host: string;
  port: number;
  shard: number;
  role: 'master' | 'slave';
  zone: string;
  configEpoch: number;
  hung: boolean;
}

export interface CommandStats {
  count: number;
  bytesIn: number;
  bytesOut: number;
}

export interface FakeClusterStats {
  commands: Record<string, CommandStats>;
  unknownCommands: Record<string, number>;
  totalCommands: number;
  bytesIn: number;
  bytesOut: number;
  commandsByNode: number[];
  connectionsByNode: number[];
  connectionsOpen: number;
  connectionsOpened: number;
  peakConnections: number;
}

interface ClientConnection {
  id: number;
  socket: Socket;
  node: FakeNode;
  parser: RespRequestParser;
  held: Buffer[];
  name: string;
  openedAt: number;
  commands: number;
  bytesIn: number;
  bytesOut: number;
}

const hex40 = (seed: string): string => createHash('sha1').update(seed).digest('hex');

const listenOn = (server: Server, host: string): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve((server.address() as { port: number }).port));
  });

const matchesPattern = (pattern: string, value: string): boolean => {
  if (!pattern.includes('*')) return pattern === value;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
};

export class FakeCluster {
  readonly nodes: FakeNode[] = [];
  private readonly servers: Server[] = [];
  private readonly connections = new Set<ClientConnection>();
  private readonly shardSlots: Array<[number, number]> = [];
  private readonly startedAt = Date.now();
  private readonly version: string;
  private currentEpoch = 0;
  private clusterState: 'ok' | 'fail' = 'ok';
  private nextClientId = 1;
  private commands = new Map<string, CommandStats>();
  private unknownCommands = new Map<string, number>();
  private commandsByNode: number[] = [];
  private bytesIn = 0;
  private bytesOut = 0;
  private connectionsOpened = 0;
  private peakConnections = 0;
  private nodeLines: string[] | null = null;
  private shardsReply: Reply | null = null;

  private constructor(private readonly options: FakeClusterOptions) {
    this.version = options.version ?? '9.0.0';
  }

  static async start(options: FakeClusterOptions): Promise<FakeCluster> {
    const cluster = new FakeCluster(options);
    await cluster.listen();
    return cluster;
  }

  get seed(): { host: string; port: number } {
    return { host: this.nodes[0].host, port: this.nodes[0].port };
  }

  hang(index: number): void {
    this.nodes[index].hung = true;
  }

  resume(index: number): void {
    const node = this.nodes[index];
    node.hung = false;
    for (const connection of this.connections) {
      if (connection.node !== node) continue;
      for (const chunk of connection.held.splice(0)) this.receive(connection, chunk);
    }
  }

  failover(shard: number): FakeNode {
    const members = this.nodes.filter((node) => node.shard === shard);
    const oldPrimary = members.find((node) => node.role === 'master');
    const promoted = members.find((node) => node.role === 'slave');
    if (!oldPrimary || !promoted) throw new Error(`Shard ${shard} has no replica to promote`);

    this.currentEpoch += 1;
    promoted.role = 'master';
    promoted.configEpoch = this.currentEpoch;
    oldPrimary.role = 'slave';
    this.invalidateTopology();
    return promoted;
  }

  setClusterState(state: 'ok' | 'fail'): void {
    this.clusterState = state;
  }

  stats(): FakeClusterStats {
    const connectionsByNode = this.nodes.map(() => 0);
    for (const connection of this.connections) connectionsByNode[connection.node.index] += 1;
    return {
      commands: Object.fromEntries([...this.commands].map(([key, value]) => [key, { ...value }])),
      unknownCommands: Object.fromEntries(this.unknownCommands),
      totalCommands: [...this.commands.values()].reduce((sum, entry) => sum + entry.count, 0),
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      commandsByNode: [...this.commandsByNode],
      connectionsByNode,
      connectionsOpen: this.connections.size,
      connectionsOpened: this.connectionsOpened,
      peakConnections: this.peakConnections,
    };
  }

  resetStats(): void {
    this.commands = new Map();
    this.unknownCommands = new Map();
    this.commandsByNode = this.nodes.map(() => 0);
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.connectionsOpened = 0;
    this.peakConnections = this.connections.size;
  }

  async stop(): Promise<void> {
    for (const connection of this.connections) connection.socket.destroy();
    this.connections.clear();
    await Promise.all(
      this.servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
  }

  private async listen(): Promise<void> {
    const host = this.options.host ?? '127.0.0.1';
    const zones = this.options.zones?.length ? this.options.zones : ['zone-a', 'zone-b', 'zone-c'];
    const perShard = 1 + this.options.replicasPerShard;
    const slotsPerShard = Math.floor(TOTAL_SLOTS / this.options.shards);

    for (let shard = 0; shard < this.options.shards; shard++) {
      const start = shard * slotsPerShard;
      const end = shard === this.options.shards - 1 ? TOTAL_SLOTS - 1 : start + slotsPerShard - 1;
      this.shardSlots.push([start, end]);
      for (let member = 0; member < perShard; member++) {
        const index = this.nodes.length;
        this.nodes.push({
          index,
          id: hex40(`node-${index}`),
          runId: hex40(`run-${index}`),
          host,
          port: 0,
          shard,
          role: member === 0 ? 'master' : 'slave',
          zone: zones[(shard + member) % zones.length],
          configEpoch: shard + 1,
          hung: false,
        });
      }
    }
    this.currentEpoch = this.options.shards;
    this.commandsByNode = this.nodes.map(() => 0);

    await Promise.all(
      this.nodes.map(async (node) => {
        const server = createServer((socket) => this.accept(node, socket));
        this.servers.push(server);
        node.port = await listenOn(server, host);
      }),
    );
  }

  private accept(node: FakeNode, socket: Socket): void {
    const connection: ClientConnection = {
      id: this.nextClientId++,
      socket,
      node,
      parser: new RespRequestParser(),
      held: [],
      name: '',
      openedAt: Date.now(),
      commands: 0,
      bytesIn: 0,
      bytesOut: 0,
    };
    this.connections.add(connection);
    this.connectionsOpened += 1;
    this.peakConnections = Math.max(this.peakConnections, this.connections.size);
    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      if (node.hung) connection.held.push(chunk);
      else this.receive(connection, chunk);
    });
    socket.on('error', () => undefined);
    socket.on('close', () => this.connections.delete(connection));
  }

  private receive(connection: ClientConnection, chunk: Buffer): void {
    connection.parser.push(chunk);
    let output = '';
    for (let command = connection.parser.next(); command; command = connection.parser.next()) {
      if (command.args.length === 0) continue;
      const name = command.args[0].toUpperCase();
      const key = this.statsKey(name, command.args);
      const reply = encodeReply(this.handle(connection, name, command.args));
      const bytesOut = Buffer.byteLength(reply);
      this.record(connection, key, command.bytes, bytesOut);
      output += reply;
      if (name === 'QUIT') {
        connection.socket.end(output);
        return;
      }
    }
    if (output) connection.socket.write(output);
  }

  private statsKey(name: string, args: string[]): string {
    if (name === 'INFO') return `INFO ${args.slice(1).map((arg) => arg.toLowerCase()).join(',') || 'default'}`;
    if (CONTAINER_COMMANDS.has(name) && args[1]) return `${name} ${args[1].toUpperCase()}`;
    return name;
  }

  private record(connection: ClientConnection, key: string, bytesIn: number, bytesOut: number): void {
    const entry = this.commands.get(key) ?? { count: 0, bytesIn: 0, bytesOut: 0 };
    entry.count += 1;
    entry.bytesIn += bytesIn;
    entry.bytesOut += bytesOut;
    this.commands.set(key, entry);
    this.bytesIn += bytesIn;
    this.bytesOut += bytesOut;
    this.commandsByNode[connection.node.index] += 1;
    connection.commands += 1;
    connection.bytesIn += bytesIn;
    connection.bytesOut += bytesOut;
  }

  private handle(connection: ClientConnection, name: string, args: string[]): Reply {
    const node = connection.node;
    const sub = (args[1] ?? '').toUpperCase();
    switch (name) {
      case 'PING':
        return args[1] === undefined ? simple('PONG') : args[1];
      case 'ECHO':
        return args[1] ?? '';
      case 'AUTH':
      case 'SELECT':
      case 'READONLY':
      case 'READWRITE':
      case 'QUIT':
      case 'MONITOR':
        return OK;
      case 'INFO':
        return this.info(node, args.slice(1));
      case 'CLUSTER':
        return this.cluster(node, sub, args);
      case 'CLIENT':
        return this.client(connection, sub, args);
      case 'CONFIG':
        return this.config(node, sub, args);
      case 'ACL':
        return this.acl(sub);
      case 'SLOWLOG':
      case 'COMMANDLOG':
        return sub === 'GET' ? [] : sub === 'LEN' ? 0 : sub === 'RESET' ? OK : this.unknown(name, args);
      case 'LATENCY':
        if (sub === 'DOCTOR') return 'Dave, no latency spike was observed during the lifetime of this instance.';
        return sub === 'RESET' ? 0 : [];
      case 'MEMORY':
        return this.memory(node, sub);
      case 'COMMAND':
        return sub === 'COUNT' ? 241 : [];
      case 'MODULE':
      case 'FUNCTION':
      case 'PUBSUB':
        return [];
      case 'DBSIZE':
        return this.keyCount(node);
      case 'ROLE':
        return this.role(node);
      case 'TIME':
        return [String(Math.floor(Date.now() / 1000)), String((Date.now() % 1000) * 1000)];
      case 'LASTSAVE':
        return Math.floor(this.startedAt / 1000);
      case 'WAIT':
      case 'EXISTS':
      case 'DEL':
      case 'UNLINK':
        return 0;
      case 'TTL':
      case 'PTTL':
        return -2;
      case 'TYPE':
        return simple('none');
      case 'GET':
      case 'RANDOMKEY':
      case 'OBJECT':
        return null;
      case 'SCAN':
        return ['0', []];
      case 'KEYS':
      case 'HGETALL':
      case 'SMEMBERS':
      case 'LRANGE':
        return [];
      default:
        return this.unknown(name, args);
    }
  }

  private unknown(name: string, args: string[]): Reply {
    const key = CONTAINER_COMMANDS.has(name) && args[1] ? `${name} ${args[1].toUpperCase()}` : name;
    this.unknownCommands.set(key, (this.unknownCommands.get(key) ?? 0) + 1);
    const preview = args
      .slice(1, 4)
      .map((arg) => `'${arg}'`)
      .join(' ');
    return error(`ERR unknown command '${args[0]}', with args beginning with: ${preview}`);
  }

  private elapsedSeconds(): number {
    return (Date.now() - this.startedAt) / 1000;
  }

  private replOffset(): number {
    return 1_000_000 + Math.floor(this.elapsedSeconds() * REPL_BYTES_PER_SECOND);
  }

  private keyCount(node: FakeNode): number {
    const [start, end] = this.shardSlots[node.shard];
    return (end - start + 1) * KEYS_PER_SLOT;
  }

  private primaryOf(node: FakeNode): FakeNode {
    return this.nodes.find((candidate) => candidate.shard === node.shard && candidate.role === 'master') ?? node;
  }

  private replicasOf(node: FakeNode): FakeNode[] {
    return this.nodes.filter((candidate) => candidate.shard === node.shard && candidate.role === 'slave');
  }

  private nodeConnections(node: FakeNode): ClientConnection[] {
    return [...this.connections].filter((connection) => connection.node === node);
  }

  private info(node: FakeNode, requested: string[]): Reply {
    const wanted = requested.map((section) => section.toLowerCase());
    const sections =
      wanted.length === 0 || wanted.includes('default')
        ? DEFAULT_INFO_SECTIONS
        : wanted.includes('all') || wanted.includes('everything')
          ? ALL_INFO_SECTIONS
          : wanted;
    return sections
      .map((section) => this.infoSection(node, section))
      .filter(Boolean)
      .join('\r\n');
  }

  private infoSection(node: FakeNode, section: string): string {
    const lines = this.infoLines(node, section);
    if (!lines) return '';
    const title = section.charAt(0).toUpperCase() + section.slice(1);
    return [`# ${title}`, ...lines, ''].join('\r\n');
  }

  private infoLines(node: FakeNode, section: string): string[] | null {
    const elapsed = this.elapsedSeconds();
    const uptime = Math.floor(elapsed) + 86_400;
    const offset = this.replOffset();
    const commandsProcessed = Math.floor((elapsed + 86_400) * OPS_PER_SECOND);
    switch (section) {
      case 'server':
        return [
          'redis_version:7.2.4',
          'server_name:valkey',
          `valkey_version:${this.version}`,
          'valkey_release_stage:ga',
          'redis_git_sha1:00000000',
          'redis_git_dirty:0',
          'redis_build_id:fake0000fake0000',
          'server_mode:cluster',
          'redis_mode:cluster',
          'os:Linux 6.1.0 x86_64',
          'arch_bits:64',
          'monotonic_clock:POSIX clock_gettime',
          'multiplexing_api:epoll',
          'gcc_version:12.2.0',
          `process_id:${1000 + node.index}`,
          'process_supervised:no',
          `run_id:${node.runId}`,
          `tcp_port:${node.port}`,
          `server_time_usec:${Date.now() * 1000}`,
          `uptime_in_seconds:${uptime}`,
          `uptime_in_days:${Math.floor(uptime / 86_400)}`,
          'hz:10',
          'configured_hz:10',
          'clients_hz:10',
          'lru_clock:1000000',
          'executable:/usr/local/bin/valkey-server',
          'config_file:/etc/valkey/valkey.conf',
          'io_threads_active:0',
          `availability_zone:${node.zone}`,
          'listener0:name=tcp,bind=*,bind=-::*,port=' + node.port,
        ];
      case 'clients':
        return [
          `connected_clients:${SYNTHETIC_CLIENTS + this.nodeConnections(node).length}`,
          `cluster_connections:${(this.nodes.length - 1) * 2}`,
          'maxclients:10000',
          'client_recent_max_input_buffer:20480',
          'client_recent_max_output_buffer:0',
          'blocked_clients:0',
          'tracking_clients:0',
          'pubsub_clients:0',
          'watching_clients:0',
          'clients_in_timeout_table:0',
          'total_watched_keys:0',
          'total_blocking_keys:0',
          'total_blocking_keys_on_nokey:0',
        ];
      case 'memory':
        return [
          'used_memory:2147483648',
          'used_memory_human:2.00G',
          'used_memory_rss:2362232012',
          'used_memory_rss_human:2.20G',
          'used_memory_peak:2254857830',
          'used_memory_peak_human:2.10G',
          'used_memory_peak_perc:95.24%',
          'used_memory_overhead:104857600',
          'used_memory_startup:1048576',
          'used_memory_dataset:2042626048',
          'used_memory_dataset_perc:95.16%',
          'allocator_allocated:2147483648',
          'allocator_active:2190433320',
          'allocator_resident:2362232012',
          'total_system_memory:17179869184',
          'total_system_memory_human:16.00G',
          'used_memory_lua:31744',
          'used_memory_scripts:0',
          'maxmemory:8589934592',
          'maxmemory_human:8.00G',
          'maxmemory_policy:allkeys-lru',
          'allocator_frag_ratio:1.02',
          'allocator_frag_bytes:42949672',
          'allocator_rss_ratio:1.08',
          'allocator_rss_bytes:171798692',
          'rss_overhead_ratio:1.00',
          'rss_overhead_bytes:0',
          'mem_fragmentation_ratio:1.10',
          'mem_fragmentation_bytes:214748364',
          'mem_not_counted_for_evict:0',
          'mem_replication_backlog:10485760',
          'mem_total_replication_buffers:10485760',
          'mem_clients_slaves:0',
          'mem_clients_normal:450000',
          'mem_cluster_links:1048576',
          'mem_aof_buffer:0',
          'mem_allocator:jemalloc-5.3.0',
          'active_defrag_running:0',
          'lazyfree_pending_objects:0',
          'lazyfreed_objects:0',
        ];
      case 'persistence':
        return [
          'loading:0',
          'async_loading:0',
          'current_cow_peak:0',
          'current_cow_size:0',
          'current_fork_perc:0.00',
          'current_save_keys_processed:0',
          'current_save_keys_total:0',
          'rdb_changes_since_last_save:120',
          'rdb_bgsave_in_progress:0',
          `rdb_last_save_time:${Math.floor(this.startedAt / 1000)}`,
          'rdb_last_bgsave_status:ok',
          'rdb_last_bgsave_time_sec:2',
          'rdb_current_bgsave_time_sec:-1',
          'rdb_saves:4',
          'rdb_last_cow_size:1048576',
          'aof_enabled:0',
          'aof_rewrite_in_progress:0',
          'aof_rewrite_scheduled:0',
          'aof_last_rewrite_time_sec:-1',
          'aof_current_rewrite_time_sec:-1',
          'aof_last_bgrewrite_status:ok',
          'aof_last_write_status:ok',
          'aof_last_cow_size:0',
          'module_fork_in_progress:0',
          'module_fork_last_cow_size:0',
        ];
      case 'stats':
        return [
          `total_connections_received:${5000 + this.connectionsOpened}`,
          `total_commands_processed:${commandsProcessed}`,
          `instantaneous_ops_per_sec:${OPS_PER_SECOND}`,
          `total_net_input_bytes:${commandsProcessed * 64}`,
          `total_net_output_bytes:${commandsProcessed * 96}`,
          `total_net_repl_input_bytes:${node.role === 'slave' ? offset : 0}`,
          `total_net_repl_output_bytes:${node.role === 'master' ? offset : 0}`,
          'instantaneous_input_kbps:75.00',
          'instantaneous_output_kbps:112.50',
          'instantaneous_input_repl_kbps:0.00',
          'instantaneous_output_repl_kbps:46.88',
          'rejected_connections:0',
          'sync_full:1',
          'sync_partial_ok:0',
          'sync_partial_err:0',
          'expired_keys:1200',
          'expired_stale_perc:0.00',
          'expired_time_cap_reached_count:0',
          'expire_cycle_cpu_milliseconds:800',
          'evicted_keys:0',
          'evicted_clients:0',
          'evicted_scripts:0',
          'total_eviction_exceeded_time:0',
          'current_eviction_exceeded_time:0',
          `keyspace_hits:${Math.floor(commandsProcessed * 0.6)}`,
          `keyspace_misses:${Math.floor(commandsProcessed * 0.05)}`,
          'pubsub_channels:0',
          'pubsub_patterns:0',
          'pubsubshard_channels:0',
          'latest_fork_usec:1500',
          'total_forks:4',
          'migrate_cached_sockets:0',
          'slave_expires_tracked_keys:0',
          'active_defrag_hits:0',
          'active_defrag_misses:0',
          'active_defrag_key_hits:0',
          'active_defrag_key_misses:0',
          'total_active_defrag_time:0',
          'current_active_defrag_time:0',
          'tracking_total_keys:0',
          'tracking_total_items:0',
          'tracking_total_prefixes:0',
          'unexpected_error_replies:0',
          'total_error_replies:12',
          'dump_payload_sanitizations:0',
          'total_reads_processed:0',
          'total_writes_processed:0',
          'io_threaded_reads_processed:0',
          'io_threaded_writes_processed:0',
          'client_query_buffer_limit_disconnections:0',
          'client_output_buffer_limit_disconnections:0',
          'reply_buffer_shrinks:0',
          'reply_buffer_expands:0',
          'acl_access_denied_auth:0',
          'acl_access_denied_cmd:0',
          'acl_access_denied_key:0',
          'acl_access_denied_channel:0',
        ];
      case 'replication':
        return this.replicationLines(node, offset);
      case 'cpu':
        return [
          `used_cpu_sys:${(uptime * 0.01).toFixed(6)}`,
          `used_cpu_user:${(uptime * 0.02).toFixed(6)}`,
          'used_cpu_sys_children:0.010000',
          'used_cpu_user_children:0.020000',
          `used_cpu_sys_main_thread:${(uptime * 0.009).toFixed(6)}`,
          `used_cpu_user_main_thread:${(uptime * 0.018).toFixed(6)}`,
        ];
      case 'modules':
      case 'errorstats':
        return [];
      case 'cluster':
        return ['cluster_enabled:1'];
      case 'keyspace':
        return [`db0:keys=${this.keyCount(node)},expires=120,avg_ttl=3600000`];
      case 'commandstats':
        return TRACKED_COMMANDS.map((command, position) => {
          const calls = Math.floor(commandsProcessed / (position + 2));
          return `cmdstat_${command}:calls=${calls},usec=${calls * 3},usec_per_call=3.00,rejected_calls=0,failed_calls=0`;
        });
      case 'latencystats':
        return TRACKED_COMMANDS.map(
          (command) => `latency_percentiles_usec_${command}:p50=1.003,p99=8.031,p99.9=24.063`,
        );
      default:
        return null;
    }
  }

  private replicationLines(node: FakeNode, offset: number): string[] {
    const replId = hex40(`replid-${node.shard}`);
    const backlog = [
      `master_replid:${replId}`,
      'master_replid2:0000000000000000000000000000000000000000',
      `master_repl_offset:${offset}`,
      'second_repl_offset:-1',
      'repl_backlog_active:1',
      'repl_backlog_size:10485760',
      `repl_backlog_first_byte_offset:${Math.max(1, offset - 1_048_576)}`,
      `repl_backlog_histlen:${Math.min(offset, 1_048_576)}`,
    ];
    if (node.role === 'master') {
      const replicas = this.replicasOf(node);
      return [
        'role:master',
        `connected_slaves:${replicas.length}`,
        ...replicas.map(
          (replica, position) =>
            `slave${position}:ip=${replica.host},port=${replica.port},state=online,offset=${offset},lag=0`,
        ),
        'master_failover_state:no-failover',
        ...backlog,
      ];
    }
    const primary = this.primaryOf(node);
    return [
      'role:slave',
      `master_host:${primary.host}`,
      `master_port:${primary.port}`,
      'master_link_status:up',
      'master_last_io_seconds_ago:0',
      'master_sync_in_progress:0',
      `slave_read_repl_offset:${offset}`,
      `slave_repl_offset:${offset}`,
      'slave_priority:100',
      'slave_read_only:1',
      'replica_announced:1',
      'connected_slaves:0',
      'master_failover_state:no-failover',
      ...backlog,
    ];
  }

  private invalidateTopology(): void {
    this.nodeLines = null;
    this.shardsReply = null;
  }

  private baseNodeLines(): string[] {
    if (this.nodeLines) return this.nodeLines;
    const now = Date.now();
    this.nodeLines = this.nodes.map((node) => {
      const address = `${node.host}:${node.port}@${node.port + 10_000},`;
      if (node.role === 'master') {
        const [start, end] = this.shardSlots[node.shard];
        return `${node.id} ${address} master - 0 ${now} ${node.configEpoch} connected ${start}-${end}`;
      }
      const primary = this.primaryOf(node);
      return `${node.id} ${address} slave ${primary.id} 0 ${now} ${primary.configEpoch} connected`;
    });
    return this.nodeLines;
  }

  private clusterNodes(node: FakeNode): string {
    const lines = this.baseNodeLines().slice();
    const own = lines[node.index];
    const flagsStart = own.indexOf(' ', own.indexOf(' ') + 1) + 1;
    lines[node.index] = `${own.slice(0, flagsStart)}myself,${own.slice(flagsStart)}`;
    return `${lines.join('\n')}\n`;
  }

  private clusterShards(): Reply {
    if (this.shardsReply) return this.shardsReply;
    const offset = this.replOffset();
    this.shardsReply = this.shardSlots.map(([start, end], shard) => [
      'slots',
      [start, end],
      'nodes',
      this.nodes
        .filter((node) => node.shard === shard)
        .map((node) => [
          'id',
          node.id,
          'port',
          node.port,
          'ip',
          node.host,
          'endpoint',
          node.host,
          'role',
          node.role === 'master' ? 'master' : 'replica',
          'replication-offset',
          offset,
          'health',
          'online',
          'availability-zone',
          node.zone,
        ]),
    ]);
    return this.shardsReply;
  }

  private cluster(node: FakeNode, sub: string, args: string[]): Reply {
    switch (sub) {
      case 'INFO':
        return [
          `cluster_state:${this.clusterState}`,
          `cluster_slots_assigned:${TOTAL_SLOTS}`,
          `cluster_slots_ok:${TOTAL_SLOTS}`,
          'cluster_slots_pfail:0',
          'cluster_slots_fail:0',
          `cluster_known_nodes:${this.nodes.length}`,
          `cluster_size:${this.options.shards}`,
          `cluster_current_epoch:${this.currentEpoch}`,
          `cluster_my_epoch:${this.primaryOf(node).configEpoch}`,
          `cluster_stats_messages_sent:${Math.floor(this.elapsedSeconds() * this.nodes.length)}`,
          `cluster_stats_messages_received:${Math.floor(this.elapsedSeconds() * this.nodes.length)}`,
          'total_cluster_links_buffer_limit_exceeded:0',
          '',
        ].join('\r\n');
      case 'NODES':
        return this.clusterNodes(node);
      case 'SHARDS':
        return this.clusterShards();
      case 'MYID':
        return node.id;
      case 'MYSHARDID':
        return hex40(`shard-${node.shard}`);
      case 'SLOTS':
        return this.shardSlots.map(([start, end], shard) => [
          start,
          end,
          ...this.nodes
            .filter((candidate) => candidate.shard === shard)
            .sort((left, right) => (left.role === right.role ? 0 : left.role === 'master' ? -1 : 1))
            .map((candidate) => [candidate.host, candidate.port, candidate.id, []]),
        ]);
      case 'SLOT-STATS':
        return this.slotStats(node, args);
      case 'REPLICAS':
      case 'SLAVES':
        return [];
      case 'GETSLOTMIGRATIONS':
      case 'LINKS':
      case 'GETKEYSINSLOT':
        return [];
      case 'COUNTKEYSINSLOT':
      case 'COUNT-FAILURE-REPORTS':
        return 0;
      case 'KEYSLOT':
        return 0;
      default:
        return this.unknown('CLUSTER', args);
    }
  }

  private slotStats(node: FakeNode, args: string[]): Reply {
    const [ownStart, ownEnd] = this.shardSlots[node.shard];
    const upper = args.map((arg) => arg.toUpperCase());
    let start = ownStart;
    let end = ownEnd;
    const rangeAt = upper.indexOf('SLOTSRANGE');
    if (rangeAt !== -1) {
      start = Math.max(ownStart, Number(args[rangeAt + 1]));
      end = Math.min(ownEnd, Number(args[rangeAt + 2]));
    }
    const limitAt = upper.indexOf('LIMIT');
    if (limitAt !== -1) end = Math.min(end, start + Number(args[limitAt + 1]) - 1);
    const usec = Math.floor(this.elapsedSeconds() * 1000);
    const reply: Reply[] = [];
    for (let slot = start; slot <= end; slot++) {
      reply.push([
        slot,
        ['key-count', KEYS_PER_SLOT, 'cpu-usec', usec, 'network-bytes-in', usec * 8, 'network-bytes-out', usec * 12],
      ]);
    }
    return reply;
  }

  private client(connection: ClientConnection, sub: string, args: string[]): Reply {
    switch (sub) {
      case 'SETNAME':
        connection.name = args[2] ?? '';
        return OK;
      case 'SETINFO':
      case 'NO-EVICT':
      case 'NO-TOUCH':
      case 'REPLY':
        return OK;
      case 'GETNAME':
        return connection.name || null;
      case 'ID':
        return connection.id;
      case 'INFO':
        return `${this.clientLine(connection)}\n`;
      case 'LIST':
        return this.clientList(connection.node);
      case 'KILL':
        return 0;
      default:
        return this.unknown('CLIENT', args);
    }
  }

  private clientLine(connection: ClientConnection): string {
    const age = Math.floor((Date.now() - connection.openedAt) / 1000);
    return this.formatClient({
      id: connection.id,
      addr: `${connection.socket.remoteAddress ?? '127.0.0.1'}:${connection.socket.remotePort ?? 0}`,
      laddr: `${connection.node.host}:${connection.node.port}`,
      name: connection.name,
      age,
      idle: 0,
      cmd: 'client|list',
      netIn: connection.bytesIn,
      netOut: connection.bytesOut,
      commands: connection.commands,
    });
  }

  private formatClient(client: {
    id: number;
    addr: string;
    laddr: string;
    name: string;
    age: number;
    idle: number;
    cmd: string;
    netIn: number;
    netOut: number;
    commands: number;
  }): string {
    return (
      `id=${client.id} addr=${client.addr} laddr=${client.laddr} fd=${10 + (client.id % 900)} name=${client.name} ` +
      `age=${client.age} idle=${client.idle} flags=N db=0 sub=0 psub=0 ssub=0 multi=-1 watch=0 qbuf=26 ` +
      'qbuf-free=20448 argv-mem=10 multi-mem=0 rbs=1024 rbp=0 obl=0 oll=0 omem=0 tot-mem=22426 events=r ' +
      `cmd=${client.cmd} user=default redir=-1 resp=2 lib-name=iovalkey lib-ver=0.3.3 io-thread=0 ` +
      `tot-net-in=${client.netIn} tot-net-out=${client.netOut} tot-cmds=${client.commands}`
    );
  }

  private clientList(node: FakeNode): string {
    const age = Math.floor(this.elapsedSeconds()) + 600;
    const synthetic = Array.from({ length: SYNTHETIC_CLIENTS }, (_, position) =>
      this.formatClient({
        id: 1_000_000 + node.index * 100 + position,
        addr: `10.0.${node.shard % 250}.${10 + position}:${40_000 + position}`,
        laddr: `${node.host}:${node.port}`,
        name: `app-${position % 4}`,
        age,
        idle: position % 3,
        cmd: position % 2 ? 'get' : 'set',
        netIn: age * 6400,
        netOut: age * 9600,
        commands: age * 60,
      }),
    );
    const real = this.nodeConnections(node).map((connection) => this.clientLine(connection));
    return `${[...synthetic, ...real].join('\n')}\n`;
  }

  private config(node: FakeNode, sub: string, args: string[]): Reply {
    if (sub !== 'GET') return sub === 'SET' || sub === 'RESETSTAT' ? OK : this.unknown('CONFIG', args);
    const values: Record<string, string> = {
      maxmemory: '8589934592',
      'maxmemory-policy': 'allkeys-lru',
      maxclients: '10000',
      'slowlog-log-slower-than': '10000',
      'slowlog-max-len': '128',
      'commandlog-execution-slower-than': '10000',
      'commandlog-slow-execution-max-len': '128',
      'commandlog-request-larger-than': '1048576',
      'commandlog-large-request-max-len': '128',
      'commandlog-reply-larger-than': '1048576',
      'commandlog-large-reply-max-len': '128',
      'latency-monitor-threshold': '0',
      'latency-tracking': 'yes',
      'cluster-enabled': 'yes',
      'cluster-node-timeout': '15000',
      'cluster-require-full-coverage': 'yes',
      'cluster-allow-reads-when-down': 'no',
      'cluster-replica-validity-factor': '10',
      'cluster-migration-barrier': '1',
      'cluster-slot-stats-enabled': 'yes',
      'cluster-announce-hostname': '',
      'availability-zone': node.zone,
      'repl-backlog-size': '10485760',
      'repl-diskless-sync': 'yes',
      'min-replicas-to-write': '0',
      'client-output-buffer-limit': 'normal 0 0 0 slave 268435456 67108864 60 pubsub 33554432 8388608 60',
      appendonly: 'no',
      save: '3600 1 300 100 60 10000',
      timeout: '0',
      'tcp-keepalive': '300',
      databases: '16',
      hz: '10',
      port: String(node.port),
      bind: '* -::*',
      'notify-keyspace-events': '',
      'io-threads': '1',
      'lazyfree-lazy-eviction': 'yes',
      'active-defrag': 'no',
    };
    const reply: string[] = [];
    const seen = new Set<string>();
    for (const pattern of args.slice(2)) {
      for (const [key, value] of Object.entries(values)) {
        if (seen.has(key) || !matchesPattern(pattern.toLowerCase(), key)) continue;
        seen.add(key);
        reply.push(key, value);
      }
    }
    return reply;
  }

  private acl(sub: string): Reply {
    switch (sub) {
      case 'WHOAMI':
        return 'default';
      case 'USERS':
        return ['default'];
      case 'LIST':
        return ['user default on nopass sanitize-payload ~* &* +@all'];
      case 'GETUSER':
        return ['flags', ['on', 'nopass'], 'passwords', [], 'commands', '+@all', 'keys', '~*', 'channels', '&*', 'selectors', []];
      case 'LOG':
      case 'CAT':
        return [];
      default:
        return [];
    }
  }

  private memory(node: FakeNode, sub: string): Reply {
    if (sub === 'DOCTOR') return "Hi Sam, I can't find any memory issue in your instance.";
    if (sub === 'USAGE') return null;
    if (sub !== 'STATS') return [];
    return [
      'peak.allocated',
      2254857830,
      'total.allocated',
      2147483648,
      'startup.allocated',
      1048576,
      'replication.backlog',
      10485760,
      'clients.slaves',
      0,
      'clients.normal',
      450000,
      'cluster.links',
      1048576,
      'aof.buffer',
      0,
      'lua.caches',
      0,
      'functions.caches',
      184,
      'overhead.total',
      104857600,
      'keys.count',
      this.keyCount(node),
      'keys.bytes-per-key',
      204262,
      'dataset.bytes',
      2042626048,
      'dataset.percentage',
      '95.16',
      'peak.percentage',
      '95.24',
      'allocator.allocated',
      2147483648,
      'allocator.active',
      2190433320,
      'allocator.resident',
      2362232012,
      'allocator-fragmentation.ratio',
      '1.02',
      'allocator-fragmentation.bytes',
      42949672,
      'allocator-rss.ratio',
      '1.08',
      'allocator-rss.bytes',
      171798692,
      'rss-overhead.ratio',
      '1.00',
      'rss-overhead.bytes',
      0,
      'fragmentation',
      '1.10',
      'fragmentation.bytes',
      214748364,
    ];
  }

  private role(node: FakeNode): Reply {
    const offset = this.replOffset();
    if (node.role === 'master') {
      return ['master', offset, this.replicasOf(node).map((replica) => [replica.host, String(replica.port), String(offset)])];
    }
    const primary = this.primaryOf(node);
    return ['slave', primary.host, primary.port, 'connected', offset];
  }
}
