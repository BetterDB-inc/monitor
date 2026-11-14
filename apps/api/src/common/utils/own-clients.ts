// Connections BetterDB itself opens. A `-` suffix covers the per-node fan-out
// (`BetterDB-Monitor-Node-…`), key scans, discovery, and the session explorer.
// BetterDB-Migration-* is left visible on purpose: those are the user's data path.
const OWN_CLIENT_NAMES = ['BetterDB-Monitor', 'BetterDB-Agent', 'BetterDB-CLI'] as const;

export function isBetterDbClientName(name: string | undefined | null): boolean {
  if (!name) return false;
  return OWN_CLIENT_NAMES.some((own) => name === own || name.startsWith(`${own}-`));
}
