/**
 * How this instance was launched. Drives the one-click upgrade command shown
 * in the update banner. Detected server-side — the browser can't see whether
 * the server process came from Docker, npx, or a global install.
 */
export type InstallMethod =
  | 'docker'
  | 'podman'
  | 'kubernetes'
  | 'npm'
  | 'pnpm'
  | 'yarn'
  | 'npx'
  | 'unknown';

export interface VersionInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  checkedAt: number | null;
  versionCheckIntervalMs?: number;
  /** Best-effort detection of how this instance was launched. */
  installMethod?: InstallMethod;
  /**
   * Copy-paste command that upgrades this install to the latest version, or
   * null when there's no single safe one-liner (Kubernetes / unknown) — those
   * cases fall back to the upgrade guide at {@link updateDocsUrl}.
   */
  updateCommand?: string | null;
  /** Link to the full upgrade guide, covering cases the one-liner can't. */
  updateDocsUrl?: string;
}
