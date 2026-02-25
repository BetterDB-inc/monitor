import Valkey from 'iovalkey';

const ALLOWED_COMMANDS: Set<string> = new Set([
  'PING', 'INFO', 'DBSIZE',
  'SLOWLOG', 'COMMANDLOG',
  'LATENCY',
  'CLIENT',
  'ACL',
  'CONFIG',
  'CLUSTER',
  'MEMORY',
  'COMMAND',
  'ROLE',
  'LASTSAVE',
]);

// Subcommands that are explicitly allowed for each command
const ALLOWED_SUBCOMMANDS: Record<string, Set<string>> = {
  CONFIG: new Set(['GET']),
  CLIENT: new Set(['LIST', 'INFO', 'GETNAME']),
  ACL: new Set(['LOG', 'LIST', 'WHOAMI', 'USERS']),
  SLOWLOG: new Set(['GET', 'LEN', 'RESET']),
  COMMANDLOG: new Set(['GET', 'LEN', 'RESET']),
  LATENCY: new Set(['LATEST', 'HISTORY', 'HISTOGRAM', 'RESET', 'DOCTOR']),
  CLUSTER: new Set(['INFO', 'SLOTS', 'SLOT-STATS', 'NODES']),
  MEMORY: new Set(['DOCTOR', 'STATS']),
  COMMAND: new Set(['COUNT', 'DOCS']),
};

export class CommandExecutor {
  constructor(private readonly client: Valkey) {}

  isAllowed(cmd: string, args?: string[]): boolean {
    const upperCmd = cmd.toUpperCase();
    if (!ALLOWED_COMMANDS.has(upperCmd)) {
      return false;
    }

    const allowedSubs = ALLOWED_SUBCOMMANDS[upperCmd];
    if (allowedSubs) {
      if (!args || args.length === 0) {
        return false;
      }
      const subCmd = args[0].toUpperCase();
      return allowedSubs.has(subCmd);
    }

    // Commands without subcommand restrictions
    return true;
  }

  async execute(cmd: string, args?: string[]): Promise<unknown> {
    const upperCmd = cmd.toUpperCase();

    if (!this.isAllowed(upperCmd, args)) {
      const full = args ? `${upperCmd} ${args.join(' ')}` : upperCmd;
      throw new Error(`Command not allowed: ${full}`);
    }

    if (upperCmd === 'PING') {
      return this.client.ping();
    }

    if (upperCmd === 'INFO') {
      return args && args.length > 0
        ? this.client.info(args.join(' '))
        : this.client.info();
    }

    if (upperCmd === 'DBSIZE') {
      return this.client.dbsize();
    }

    if (upperCmd === 'LASTSAVE') {
      return this.client.lastsave();
    }

    if (upperCmd === 'CONFIG' && args) {
      return this.client.config('GET', ...args.slice(1));
    }

    // For all other commands, use call()
    const callArgs = args ? [upperCmd, ...args] : [upperCmd];
    return this.client.call(...(callArgs as [string, ...string[]]));
  }
}
