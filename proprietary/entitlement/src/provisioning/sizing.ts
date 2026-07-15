export interface ValkeySizing {
  /** Container memory limit, e.g. "1Gi" / "1536Mi". */
  memoryLimit: string;
  /** PersistentVolumeClaim size, e.g. "2Gi". */
  persistenceSize: string;
}

const UNIT_TO_MI: Record<string, number> = {
  kb: 1 / 1024,
  mb: 1,
  gb: 1024,
};

/**
 * Hard ceiling on the requested maxmemory (2gb — the largest size offered in
 * the UI). Enforced at the API boundary (CreateValkeyInstanceDto) and again in
 * ValkeyInstanceService so a hand-crafted API call can't provision an
 * arbitrarily large pod and volume.
 */
export const MAX_VALKEY_MAXMEMORY_MI = 2048;

/**
 * Parses a maxmemory string ("768mb", "1gb", ...) into MiB. Returns null for
 * missing, unparseable, or non-positive values.
 */
export function parseMaxmemoryMi(maxmemory: string): number | null {
  const match = maxmemory.trim().match(/^(\d+)(kb|mb|gb)$/i);
  if (!match) return null;
  const mi = Math.ceil(Number(match[1]) * UNIT_TO_MI[match[2].toLowerCase()]);
  return Number.isFinite(mi) && mi > 0 ? mi : null;
}

function formatMi(mi: number): string {
  return mi % 1024 === 0 ? `${mi / 1024}Gi` : `${mi}Mi`;
}

/**
 * Derives pod and volume sizing from the requested Valkey maxmemory so the
 * container limit scales with the instance size instead of staying at the
 * chart default (512Mi).
 *
 * Ratios follow the chart's documented tenant profile
 * (values-cloud-tenant.yaml: maxmemory 512mb ↔ 1Gi limit, 2Gi volume):
 * - limit = 2x maxmemory: a BGREWRITEAOF/RDB-save fork's copy-on-write pages
 *   plus rewrite buffers can spike RSS well above maxmemory under write load;
 *   keeping maxmemory near half the limit avoids OOMKills mid-rewrite.
 * - volume = 4x maxmemory: holds RDB + AOF + rewrite headroom.
 *
 * Never sizes below the chart defaults (512Mi limit, 1Gi volume). Memory
 * requests are left at the chart default on purpose, matching the tenant
 * profile. Returns null for a missing or unparseable maxmemory so the chart
 * defaults apply.
 */
export function computeValkeySizing(maxmemory: string | null): ValkeySizing | null {
  if (!maxmemory) return null;
  const maxmemoryMi = parseMaxmemoryMi(maxmemory);
  if (maxmemoryMi === null) return null;

  // Defense in depth: callers validate the cap before persisting, but never
  // size beyond it even if an oversized value slips through.
  const cappedMi = Math.min(maxmemoryMi, MAX_VALKEY_MAXMEMORY_MI);

  return {
    memoryLimit: formatMi(Math.max(512, cappedMi * 2)),
    persistenceSize: formatMi(Math.max(1024, cappedMi * 4)),
  };
}
