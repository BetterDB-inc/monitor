import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { compare, valid as validSemver } from 'semver';
import type { VersionInfo } from '@betterdb/shared';

@Injectable()
export class VersionCheckService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VersionCheckService.name);

  // Configuration from env
  private readonly currentVersion: string;
  private readonly checkIntervalMs: number;
  private readonly githubReleasesUrl: string;

  // State
  private latestVersion: string | null = null;
  private releaseUrl: string | null = null;
  private checkedAt: number | null = null;
  private checkInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.currentVersion =
      process.env.APP_VERSION || process.env.npm_package_version || 'unknown';
    this.checkIntervalMs = parseInt(
      process.env.VERSION_CHECK_INTERVAL_MS || '21600000',
      10,
    ); // 6 hours default
    this.githubReleasesUrl =
      process.env.GITHUB_RELEASES_URL ||
      'https://api.github.com/repos/betterdb-io/betterdb-monitor/releases/latest';
  }

  onModuleInit() {
    // Always log current version on startup
    this.logger.log(`BetterDB Monitor v${this.currentVersion}`);

    // Schedule initial check after 5 seconds (don't block startup)
    setTimeout(() => {
      this.performCheck().catch((err) => {
        this.logger.debug(`Initial version check failed: ${err.message}`);
      });
    }, 5000);

    // Start periodic re-check
    this.checkInterval = setInterval(
      () => this.performCheck().catch(() => {}),
      this.checkIntervalMs,
    );
    // Don't prevent process exit
    this.checkInterval.unref();
  }

  onModuleDestroy() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /**
   * Called by LicenseService when entitlement response contains version info.
   * This is the primary source — piggybacked on existing HTTP calls.
   */
  setLatestVersionFromEntitlement(version: string, url?: string): void {
    // Strip leading 'v' prefix if present
    const cleanVersion = version.startsWith('v') ? version.slice(1) : version;

    // Validate with semver
    if (!validSemver(cleanVersion)) {
      this.logger.debug(`Ignoring invalid version from entitlement: ${version}`);
      return;
    }

    this.latestVersion = cleanVersion;
    this.releaseUrl =
      url || `https://github.com/betterdb-io/betterdb-monitor/releases/tag/v${cleanVersion}`;
    this.checkedAt = Date.now();

    this.logUpdateStatus();
  }

  /**
   * Get full version info for the API endpoint
   */
  getVersionInfo(): VersionInfo {
    return {
      current: this.currentVersion,
      latest: this.latestVersion,
      updateAvailable: this.isUpdateAvailable(),
      releaseUrl: this.releaseUrl,
      checkedAt: this.checkedAt,
    };
  }

  /**
   * Get the current running version
   */
  getCurrentVersion(): string {
    return this.currentVersion;
  }

  /**
   * Check if an update is available
   */
  isUpdateAvailable(): boolean {
    if (!this.latestVersion || this.currentVersion === 'unknown') {
      return false;
    }

    const currentValid = validSemver(this.currentVersion);
    const latestValid = validSemver(this.latestVersion);

    if (!currentValid || !latestValid) {
      return false;
    }

    return compare(this.latestVersion, this.currentVersion) > 0;
  }

  /**
   * Perform a version check. Skips if recently checked via entitlement.
   */
  private async performCheck(): Promise<void> {
    // Skip if we've checked recently (entitlement piggyback already provided data)
    if (this.checkedAt && Date.now() - this.checkedAt < this.checkIntervalMs) {
      this.logger.debug('Skipping GitHub check — entitlement provided recent data');
      return;
    }

    await this.checkGitHubReleases();
    this.logUpdateStatus();
  }

  /**
   * Fetch latest version from GitHub releases API
   */
  private async checkGitHubReleases(): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const response = await fetch(this.githubReleasesUrl, {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': `BetterDB-Monitor/${this.currentVersion}`,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        this.logger.debug(`GitHub releases API returned ${response.status}`);
        return;
      }

      const data = await response.json();
      const tagName = data.tag_name;
      const htmlUrl = data.html_url;

      if (!tagName) {
        this.logger.debug('No tag_name in GitHub releases response');
        return;
      }

      // Strip leading 'v' prefix if present
      const cleanVersion = tagName.startsWith('v') ? tagName.slice(1) : tagName;

      if (!validSemver(cleanVersion)) {
        this.logger.debug(`Invalid version from GitHub: ${tagName}`);
        return;
      }

      this.latestVersion = cleanVersion;
      this.releaseUrl = htmlUrl || null;
      this.checkedAt = Date.now();
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        this.logger.debug('GitHub releases check timed out');
      } else {
        this.logger.debug(
          `GitHub releases check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Log update status to console
   */
  private logUpdateStatus(): void {
    if (this.isUpdateAvailable()) {
      this.logger.warn(
        `\u2B06 Update available: v${this.currentVersion} \u2192 v${this.latestVersion}${this.releaseUrl ? ` (${this.releaseUrl})` : ''}`,
      );
      this.logger.warn('Run `docker pull betterdb/monitor:latest` to update');
    } else if (this.latestVersion) {
      this.logger.log(`Running latest version (v${this.currentVersion})`);
    }
  }
}
